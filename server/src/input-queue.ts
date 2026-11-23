import type { InputContent, InputPriority, SessionInput } from './runtimes/adapter.js'

/** The inputs of one session, handed over as they come until the queue is closed. */
export class InputQueue implements AsyncIterable<SessionInput> {
  private readonly waiting: SessionInput[]
  private readonly sent: SessionInput[]
  private wake: (() => void) | null = null
  private closed = false

  constructor(replayed: readonly SessionInput[] = []) {
    this.waiting = [...replayed]
    this.sent = [...replayed]
  }

  push(content: InputContent, id: string, priority?: InputPriority): void {
    const input: SessionInput = { id, content, ...(priority === undefined ? {} : { priority }) }
    this.waiting.push(input)
    this.sent.push(input)
    this.wakeUp()
  }

  close(): void {
    this.closed = true
    this.wakeUp()
  }

  /** Closes this queue and returns one that hands over the same inputs again. */
  replay(): InputQueue {
    this.close()
    return new InputQueue(this.sent)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SessionInput> {
    for (;;) {
      const next = this.waiting.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) {
        return
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private wakeUp(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}
