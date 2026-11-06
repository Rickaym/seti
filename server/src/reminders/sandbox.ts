import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isolation, sandboxCommand, treeRss, type Isolation } from '../script-sandbox.js'
import { STARTED, type ReminderContext, type RunnerLimits, type RunnerReply } from './protocol.js'

export interface SandboxLimits extends RunnerLimits {
  /** From loading the script to its answer. */
  timeoutMs: number
  /** For Node to start and lock itself down before the script loads. */
  startupMs: number
  heapMb: number
  /** Resident memory of the whole process tree; buffers outside the V8 heap count too. */
  memoryMb: number
  /** Everything the process may print; past it the process is stopped. */
  outputBytes: number
}

export type ScriptOutcome =
  | { outcome: 'ok' | 'empty'; message: string | null; state?: unknown; logs: string[]; duration_ms: number }
  | { outcome: 'error' | 'timeout'; error: string; logs: string[]; duration_ms: number; interrupted?: true }

const RUNNER = fileURLToPath(new URL('./runner.ts', import.meta.url))
const WATCH_MS = 50
const STDERR_KEPT = 4096

const live = new Set<ChildProcess>()
const interrupted = new WeakSet<ChildProcess>()

/** Stops every script still running, as Seti shuts down; their runs end as interrupted. */
export function stopReminderScripts(): void {
  for (const child of live) {
    interrupted.add(child)
    child.kill('SIGKILL')
  }
}

function parseReply(text: string): RunnerReply | null {
  const last = text.trimEnd().split('\n').at(-1) ?? ''
  try {
    const parsed: unknown = JSON.parse(last)
    return typeof parsed === 'object' && parsed !== null && 'ok' in parsed ? (parsed as RunnerReply) : null
  } catch {
    return null
  }
}

function crashText(stderr: string, code: number | null, signal: NodeJS.Signals | null): string {
  if (/heap limit|out of memory/i.test(stderr)) {
    return 'The script ran out of memory'
  }
  const line = stderr
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.includes('Error'))
  const how = signal ?? `exit ${String(code)}`
  return line ?? `The script process ended without an answer (${how})`
}

const runnerLimits = (limits: SandboxLimits): RunnerLimits => ({
  messageMaxChars: limits.messageMaxChars,
  stateMaxBytes: limits.stateMaxBytes,
  logLines: limits.logLines,
  logLineChars: limits.logLineChars,
  errorChars: limits.errorChars,
})

interface Stopped {
  outcome: 'error' | 'timeout'
  error: string
}

/** Runs a reminder script once in a fresh, locked-down Node process and reads its answer. */
export async function runSandboxed(
  script: string,
  input: ReminderContext,
  limits: SandboxLimits,
  use: Isolation = isolation().isolation,
): Promise<ScriptOutcome> {
  const started = Date.now()
  const { file, args } = sandboxCommand({ runner: RUNNER }, limits.heapMb, use)
  const child = spawn(file, args, { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
  live.add(child)
  let stdout = ''
  let stderr = ''
  let bytes = 0
  let begun = false
  let stopped: Stopped | null = null
  const stop = (why: Stopped) => {
    stopped ??= why
    child.kill('SIGKILL')
  }
  let deadline = setTimeout(() => {
    stop({ outcome: 'timeout', error: `Node did not start the script within ${String(limits.startupMs / 1000)} s` })
  }, limits.startupMs)
  const watch = setInterval(() => {
    if (child.pid !== undefined && treeRss(child.pid) > limits.memoryMb * 1024 * 1024) {
      stop({ outcome: 'error', error: `The script used over ${String(limits.memoryMb)} MB of memory` })
    }
  }, WATCH_MS)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > limits.outputBytes) {
      stop({ outcome: 'error', error: `The script wrote over ${String(Math.round(limits.outputBytes / 1024))} KB` })
      return
    }
    if (!begun && (stdout + chunk).startsWith(STARTED)) {
      begun = true
      clearTimeout(deadline)
      deadline = setTimeout(() => {
        stop({ outcome: 'timeout', error: `The script ran over its ${String(limits.timeoutMs / 1000)} s timeout` })
      }, limits.timeoutMs)
    }
    stdout += chunk
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(0, STDERR_KEPT)
  })
  child.stdin.on('error', () => undefined)
  child.stdin.end(JSON.stringify({ script, input, limits: runnerLimits(limits) }))
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on('close', (exitCode, exitSignal) => {
      resolve([exitCode, exitSignal])
    })
    child.on('error', (error) => {
      stderr = error.message
      resolve([null, null])
    })
  })
  clearTimeout(deadline)
  clearInterval(watch)
  live.delete(child)
  const duration_ms = Date.now() - started
  const ended = stopped as Stopped | null
  if (interrupted.has(child)) {
    return { outcome: 'error', error: 'Seti stopped while the script ran', logs: [], duration_ms, interrupted: true }
  }
  if (ended !== null) {
    return { ...ended, logs: [], duration_ms }
  }
  const reply = parseReply(stdout)
  if (reply === null) {
    return { outcome: 'error', error: crashText(stderr, code, signal), logs: [], duration_ms }
  }
  if (!reply.ok) {
    return { outcome: 'error', error: reply.error, logs: reply.logs, duration_ms }
  }
  const kept = reply.state === undefined ? {} : { state: reply.state }
  const outcome = reply.message === null ? 'empty' : 'ok'
  return { outcome, message: reply.message, ...kept, logs: reply.logs, duration_ms }
}
