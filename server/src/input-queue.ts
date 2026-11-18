import type { UUID } from 'node:crypto'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { UserContent } from './user-content.js'

/** The user messages of one query, handed over as they come until the queue is closed. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly waiting: SDKUserMessage[]
  private readonly sent: SDKUserMessage[]
  private wake: (() => void) | null = null
  private closed = false

  constructor(replayed: readonly SDKUserMessage[] = []) {
    this.waiting = [...replayed]
    this.sent = [...replayed]
  }

  push(content: UserContent, uuid: UUID, priority?: SDKUserMessage['priority']): void {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid,
      ...(priority === undefined ? {} : { priority }),
      // Claude Code joins only a person's "now" message to the running turn; others end it.
      ...(priority === 'now' ? { origin: { kind: 'human' } } : {}),
    }
    this.waiting.push(message)
    this.sent.push(message)
    this.wakeUp()
  }

  close(): void {
    this.closed = true
    this.wakeUp()
  }

  /** Closes this queue and returns one that hands over the same messages again. */
  replay(): InputQueue {
    this.close()
    return new InputQueue(this.sent)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
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
