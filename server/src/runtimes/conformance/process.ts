import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'

/** A process a rig hands the adapter: real pipes, no operating system process behind them. */
export class FakeProcess extends ChildProcess {
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
