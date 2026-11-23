import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { Launcher } from '../../launcher.js'
import type { Script } from './script.js'

/** A process a rig hands the adapter: real pipes, no operating system process behind them. */
export class FakeProcess extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  private finished = false
  private readonly deaf: boolean

  /** A deaf process ignores the signal and `kill`; only `finish` ends it. */
  constructor(signal: AbortSignal, deaf = false) {
    super()
    this.deaf = deaf
    signal.addEventListener('abort', () => {
      this.kill()
    })
  }

  /** The process has exited, or is about to. */
  get ended(): boolean {
    return this.finished
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    if (!this.deaf) {
      this.finish(null, typeof signal === 'string' ? signal : 'SIGTERM')
    }
    return true
  }

  /** Ends the output pipes and reports the exit, once. */
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

type Spawn = NonNullable<Launcher['spawn']>

/** The sandboxed launcher a script sets up: its environment and a spawn that starts or refuses. */
export function launcherOf(script: Script, start: Spawn): Launcher {
  const env = script.launcher?.env ?? {}
  const mode = script.launcher?.spawn
  if (mode === 'missing') {
    return { sandboxed: true, env }
  }
  const refuse: Spawn = () => {
    throw new Error('The sandbox refused to start the process')
  }
  return { sandboxed: true, env, spawn: mode === 'throws' ? refuse : start }
}
