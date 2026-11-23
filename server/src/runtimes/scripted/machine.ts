import { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import type { Launcher } from '../../launcher.js'
import type { Script } from '../conformance/script.js'
import type { Rig, SpawnRecord } from '../conformance/target.js'
import type { ScriptedCommand } from './dialect.js'
import { ScriptedRuntime, type MachineState } from './runtime.js'

type LaunchRequest = Parameters<NonNullable<Launcher['spawn']>>[0]

/** A process of the scripted runtime: real pipes, no operating system process behind them. */
class ScriptedProcess extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  private finished = false

  constructor(signal: AbortSignal) {
    super()
    signal.addEventListener('abort', () => {
      this.finish(null, 'SIGTERM')
    })
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.finish(null, typeof signal === 'string' ? signal : 'SIGTERM')
    return true
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) {
      return
    }
    this.finished = true
    this.stdout.push(null)
    this.stderr.push(null)
    setImmediate(() => this.emit('exit', code, signal))
  }
}

/** Connects a new scripted runtime to the process's pipes. */
function boot(child: ScriptedProcess, state: MachineState): void {
  const { stdout } = child
  const runtime = new ScriptedRuntime(state, {
    write: (line) => {
      stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
    },
    fail: (text, code) => {
      child.stderr.push(`${text}\n`)
      child.finish(code, null)
    },
  })
  const lines = createInterface({ input: child.stdin })
  lines.on('line', (line) => {
    runtime.receive(JSON.parse(line) as ScriptedCommand)
  })
}

/**
 * A host where the scripted runtime plays the script. Its launcher starts the runtime the way
 * Seti's sandbox launcher starts a real one; saved sessions survive from one process to the next.
 */
export function scriptedMachine(script: Script, env: Record<string, string> = {}): Rig {
  const state: MachineState = { script, sessions: new Map(), effects: [], turns: 0 }
  const spawns: SpawnRecord[] = []
  const spawn = (request: LaunchRequest) => {
    spawns.push({ command: request.command, args: request.args, cwd: request.cwd, env: request.env })
    const child = new ScriptedProcess(request.signal)
    boot(child, state)
    return child
  }
  return { launcher: { sandboxed: true, env, spawn }, spawns, effects: state.effects }
}
