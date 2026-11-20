import type { JournalCursor, JournalEntry } from '@seti/shared'

const DAY_MS = 24 * 60 * 60 * 1000

/** Replies kept by message id, so a repeated command or ask gets the first reply again. */
export interface ReplyStore<T> {
  get(id: string): Promise<T | undefined>
  put(id: string, value: T): Promise<void>
}

/** A reply store in memory; replies older than `maxAgeMs` are forgotten. */
export class MemoryReplyStore<T> implements ReplyStore<T> {
  private readonly replies = new Map<string, { value: T; at: number }>()
  private readonly maxAgeMs: number
  private readonly now: () => number

  constructor(maxAgeMs = DAY_MS, now: () => number = Date.now) {
    this.maxAgeMs = maxAgeMs
    this.now = now
  }

  async get(id: string): Promise<T | undefined> {
    const reply = this.replies.get(id)
    if (reply === undefined || this.now() - reply.at > this.maxAgeMs) {
      return Promise.resolve(undefined)
    }
    return Promise.resolve(reply.value)
  }

  async put(id: string, value: T): Promise<void> {
    const now = this.now()
    for (const [key, reply] of this.replies) {
      if (now - reply.at > this.maxAgeMs) {
        this.replies.delete(key)
      }
    }
    this.replies.set(id, { value, at: now })
    return Promise.resolve()
  }
}

/** Where the control plane keeps each agent's journal and how far it has stored it. */
export interface CursorStore {
  read(agent: string): Promise<JournalCursor | undefined>
  /** The cursors to send in the welcome to `node`. */
  list(node: string): Promise<Record<string, JournalCursor>>
  /** Stores `entries` and moves the agent's cursor to the last of them, as one step. */
  commit(agent: string, epoch: string, entries: JournalEntry[]): Promise<void>
}

/** A cursor store in memory that keeps every committed entry. */
export class MemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<string, JournalCursor>()
  private readonly stored = new Map<string, JournalEntry[]>()

  async read(agent: string): Promise<JournalCursor | undefined> {
    return Promise.resolve(this.cursors.get(agent))
  }

  async list(_node: string): Promise<Record<string, JournalCursor>> {
    return Promise.resolve(Object.fromEntries(this.cursors))
  }

  async commit(agent: string, epoch: string, entries: JournalEntry[]): Promise<void> {
    const last = entries.at(-1)
    if (last !== undefined) {
      this.stored.set(agent, [...(this.stored.get(agent) ?? []), ...entries])
      this.cursors.set(agent, { epoch, seq: last.seq })
    }
    return Promise.resolve()
  }

  /** Every entry stored for `agent`, in the order it was committed. */
  entries(agent: string): JournalEntry[] {
    return this.stored.get(agent) ?? []
  }
}
