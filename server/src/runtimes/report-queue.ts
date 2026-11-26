import type { SessionReport } from './adapter.js'

/** Reports in the order they were made, read once; it ends, or fails with the session's error. */
export class ReportQueue implements AsyncIterable<SessionReport> {
  private readonly items: SessionReport[] = []
  private wake: (() => void) | null = null
  private over = false
  private error: Error | null = null

  push(report: SessionReport): void {
    if (!this.over) {
      this.items.push(report)
      this.poke()
    }
  }

  end(): void {
    this.over = true
    this.poke()
  }

  fail(error: Error): void {
    if (!this.over) {
      this.error = error
      this.end()
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SessionReport> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
      } else if (this.error !== null) {
        throw this.error
      } else if (this.over) {
        return
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      }
    }
  }

  private poke(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}
