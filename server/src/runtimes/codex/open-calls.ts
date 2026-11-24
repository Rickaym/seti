import { isCodexCall } from '@seti/shared'
import { z } from 'zod'
import type { CodexCall } from './rpc.js'

const itemNote = z.looseObject({
  threadId: z.string().optional(),
  item: z.looseObject({ type: z.string(), id: z.string() }),
})

const turnNote = z.looseObject({ threadId: z.string().optional() })

/** The agent's own tool calls Codex started and has not completed yet. */
export class OpenCalls {
  private readonly open = new Set<string>()
  private readonly root: () => string

  constructor(root: () => string) {
    this.root = root
  }

  private own(threadId: string | undefined): boolean {
    return threadId === undefined || threadId === this.root()
  }

  /** Follows the calls Codex starts and completes. */
  note(message: CodexCall): void {
    const note = itemNote.safeParse(message.params).data
    if (note === undefined || !this.own(note.threadId) || !isCodexCall(note.item.type)) {
      return
    }
    if (message.method === 'item/started') {
      this.open.add(note.item.id)
    } else if (message.method === 'item/completed') {
      this.open.delete(note.item.id)
    }
  }

  /**
   * At the end of one of the agent's own turns: the calls it leaves without an end, such as asks
   * an interrupt cut before they ran, other than commands that run on in the background.
   */
  leftBy(message: CodexCall, inBackground: (id: string) => boolean): string[] {
    if (message.method !== 'turn/completed' || !this.own(turnNote.safeParse(message.params).data?.threadId)) {
      return []
    }
    const left = [...this.open].filter((id) => !inBackground(id))
    for (const id of left) {
      this.open.delete(id)
    }
    return left
  }
}
