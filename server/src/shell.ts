import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { ShellProgress, ShellResult, Task } from '@seti/shared'
import { inBackground } from './background.js'
import { now, tasks } from './db.js'
import { HttpError } from './http.js'
import { wakeTask } from './inputs.js'
import { planScope } from './memory-cap.js'
import { launch } from './memory-scope.js'
import { agentEnv, appendMessage, isRunning, publish } from './runner.js'
import { sandboxFor } from './session-options.js'
import { shellBusy } from './shell-context.js'
import { inLane, outsideLane } from './task-lane.js'

const SHELL_TIMEOUT_MS = 120_000
const KILL_GRACE_MS = 2000
const CLOSE_GRACE_MS = 1000
const PROGRESS_MS = 250
const HEARTBEAT_MS = 1000
/** Characters of each stream the transcript stores; the rest is counted and dropped. */
const STORED_LIMIT = 1024 * 1024
const PROGRESS_TAIL = 16 * 1024

class Capture {
  private readonly decoder = new StringDecoder('utf8')
  private text = ''
  private dropped = 0

  add(chunk: Buffer): void {
    const part = this.decoder.write(chunk)
    const room = STORED_LIMIT - this.text.length
    this.text += part.slice(0, Math.max(room, 0))
    this.dropped += Math.max(part.length - room, 0)
  }

  tail(): string {
    return this.text.slice(-PROGRESS_TAIL)
  }

  result(): string {
    const rest = this.decoder.end()
    const text = `${this.text}${rest}`.slice(0, STORED_LIMIT)
    const dropped = this.dropped + Math.max(this.text.length + rest.length - STORED_LIMIT, 0)
    return dropped === 0 ? text : `${text}\n[${String(dropped)} more characters not kept]`
  }
}

interface Exit {
  code: number | null
  signal: string | null
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

const runs = new Map<string, ShellRun>()

/** One `bash -lc` process of a task; it removes itself from `runs` and records its result. */
class ShellRun {
  private readonly startedAt = Date.now()
  private readonly stdout = new Capture()
  private readonly stderr = new Capture()
  private readonly timers: NodeJS.Timeout[] = []
  private endedBy: ShellResult['ended_by'] = null
  private dirty = false
  private finished = false
  private beats = 0
  private readonly taskId: string
  private readonly info: Omit<ShellProgress, 'stdout' | 'stderr'>
  private readonly child: ChildProcess

  constructor(taskId: string, info: Omit<ShellProgress, 'stdout' | 'stderr'>, child: ChildProcess) {
    this.taskId = taskId
    this.info = info
    this.child = child
  }

  progress(): ShellProgress {
    return { ...this.info, stdout: this.stdout.tail(), stderr: this.stderr.tail() }
  }

  watch(timeoutMs: number): void {
    const { child } = this
    child.stdout?.on('data', (chunk: Buffer) => {
      this.stdout.add(chunk)
      this.dirty = true
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.add(chunk)
      this.dirty = true
    })
    this.timers.push(
      setInterval(() => {
        this.tick()
      }, PROGRESS_MS),
      setTimeout(() => {
        this.end('timeout')
      }, timeoutMs),
    )
    child.on('error', (e) => {
      this.finish({ code: null, signal: null }, e.message)
    })
    child.on('exit', (code, signal) => {
      this.timers.push(
        setTimeout(() => {
          this.finish({ code, signal })
        }, CLOSE_GRACE_MS),
      )
    })
    child.on('close', (code, signal) => {
      this.finish({ code, signal })
    })
  }

  end(reason: NonNullable<ShellResult['ended_by']>): void {
    this.endedBy ??= reason
    killGroup(this.child, 'SIGTERM')
    this.timers.push(
      setTimeout(() => {
        killGroup(this.child, 'SIGKILL')
      }, KILL_GRACE_MS),
    )
  }

  private tick(): void {
    this.beats += 1
    if (this.dirty || this.beats * PROGRESS_MS >= HEARTBEAT_MS) {
      this.dirty = false
      this.beats = 0
      publish(this.taskId, { type: 'shell', progress: this.progress() })
    }
  }

  private finish(exit: Exit, error?: string): void {
    if (this.finished) {
      return
    }
    this.finished = true
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.child.stdout?.destroy()
    this.child.stderr?.destroy()
    const result: ShellResult = {
      ...this.info,
      exit_code: exit.code,
      signal: exit.signal,
      ended_by: this.endedBy,
      duration_ms: Date.now() - this.startedAt,
      stdout: this.stdout.result(),
      stderr: [this.stderr.result(), error ?? ''].filter((text) => text !== '').join('\n'),
    }
    inBackground('shell: could not record a run', async () =>
      outsideLane(async () => inLane(this.taskId, async () => this.record(result))),
    )
  }

  /** The task stays busy until its transcript holds the result, so the next turn sees the run. */
  private async record(result: ShellResult): Promise<void> {
    try {
      if (await tasks.get(this.taskId)) {
        await appendMessage(this.taskId, { kind: 'shell', payload: result })
      }
    } finally {
      runs.delete(this.taskId)
      shellBusy.end(this.taskId)
    }
    await wakeTask(this.taskId)
  }
}

async function startShell(task: Task, command: string): Promise<ChildProcess> {
  const sandbox = await sandboxFor(task)
  const scope = await planScope(task.id, 'shell')
  if (sandbox !== null) {
    return sandbox.spawn('/bin/bash', ['-lc', command], { detached: true, stdin: 'ignore', scope })
  }
  const env = { ...agentEnv(scope?.cap ?? null), ...(scope === null ? {} : { XDG_RUNTIME_DIR: scope.host.runtimeDir }) }
  return launch(scope, '/bin/bash', ['-lc', command], (program, args) =>
    spawn(program, args, { cwd: task.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }),
  )
}

/**
 * Runs `bash -lc command` in the task directory, inside the task's sandbox when it has one;
 * output reaches the transcript through the bus.
 */
export async function runShell(task: Task, command: string, timeoutMs = SHELL_TIMEOUT_MS): Promise<ShellProgress> {
  if (isRunning(task.id)) {
    throw new HttpError(409, 'The agent is working; wait for the turn to finish or stop it')
  }
  if (runs.has(task.id)) {
    throw new HttpError(409, 'A shell command is already running for this agent')
  }
  if (!fs.existsSync(task.cwd)) {
    throw new HttpError(400, `Working directory ${task.cwd} no longer exists`)
  }
  const child = await startShell(task, command)
  const run = new ShellRun(task.id, { run_id: randomUUID(), command, cwd: task.cwd, started_at: now() }, child)
  runs.set(task.id, run)
  shellBusy.start(task.id)
  run.watch(timeoutMs)
  const progress = run.progress()
  publish(task.id, { type: 'shell', progress })
  return progress
}

export function stopShell(taskId: string): ShellProgress {
  const run = runs.get(taskId)
  if (!run) {
    throw new HttpError(409, 'No shell command is running for this agent')
  }
  run.end('user')
  return run.progress()
}
