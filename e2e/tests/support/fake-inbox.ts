/** A message Seti sends the fake Claude Code; updates say how soon a running turn takes them. */
export interface UserMessage {
  message: { content: string | { type: string; text?: string }[] }
  uuid?: string
  priority?: string
}

/** Lets one waiter sleep until something changes. */
class Sleeper {
  private waiting: (() => void) | null = null

  async sleep(): Promise<void> {
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }

  wake(): void {
    const waiting = this.waiting
    this.waiting = null
    waiting?.()
  }
}

/** The messages Seti sent that no turn took yet, read as they come like Claude Code's queue. */
export class Inbox {
  private waiting: UserMessage[] = []
  private done = false
  private readonly sleeper = new Sleeper()

  /** An inbox that takes each message as Seti sends it. */
  static reading(input: AsyncIterable<UserMessage>): Inbox {
    const inbox = new Inbox()
    void inbox.read(input)
    return inbox
  }

  private async read(input: AsyncIterable<UserMessage>): Promise<void> {
    try {
      for await (const m of input) {
        this.waiting.push(m)
        this.sleeper.wake()
      }
    } finally {
      this.done = true
      this.sleeper.wake()
    }
  }

  /** The next message to start a turn with; null once the input ended. */
  async next(): Promise<UserMessage | null> {
    for (;;) {
      const m = this.waiting.shift()
      if (m !== undefined) {
        return m
      }
      if (this.done) {
        return null
      }
      await this.sleeper.sleep()
    }
  }

  /** Takes the updates that asked to join the running turn at its next step. */
  joining(): UserMessage[] {
    const taken = this.waiting.filter((m) => m.priority === 'next')
    this.waiting = this.waiting.filter((m) => m.priority !== 'next')
    return taken
  }
}

/** A message the fake Claude Code emits, as the Agent SDK would. */
export type Message = Record<string, unknown> & { type: string }

/** What the fake Claude Code emits, drained as it comes until the session ends. */
export class Outbox {
  private readonly items: Message[] = []
  private readonly sleeper = new Sleeper()
  private failure: Error | null = null
  ended = false

  push(m: Message): void {
    this.items.push(m)
    this.sleeper.wake()
  }

  end(): void {
    this.ended = true
    this.sleeper.wake()
  }

  /** Ends the stream with an error, as a Claude Code process that exits does. */
  fail(error: Error): void {
    this.failure = error
    this.end()
  }

  async *drain(): AsyncGenerator<Message> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
      } else if (this.ended) {
        if (this.failure !== null) {
          throw this.failure
        }
        return
      } else {
        await this.sleeper.sleep()
      }
    }
  }
}
