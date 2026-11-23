import { randomUUID } from 'node:crypto'
import type { AskFrame, AskReply, JournalAppend, JournalEntry, JournalReply, NodeAskType } from '@seti/shared'

/** How many entries of one agent may wait for acknowledgement on the link at once. */
const JOURNAL_WINDOW = 64

/** One agent's journal on the node: numbered entries kept until the control plane stored them. */
class AgentJournal {
  readonly epoch = randomUUID()
  /** The number the next entry gets. */
  next = 1
  /** The highest number the control plane acknowledged. */
  acked = 0
  /** Set when the control plane refused the journal; nothing more is sent for the agent. */
  refused: string | null = null
  /** The highest number sent since the link last came up. */
  private sent = 0
  private unacked: { seq: number; entry: JournalEntry }[] = []

  add(entry: JournalEntry): number {
    const seq = this.next
    this.next += 1
    this.unacked.push({ seq, entry })
    return seq
  }

  acknowledge(seq: number): void {
    this.acked = Math.max(this.acked, Math.min(seq, this.next - 1))
    this.unacked = this.unacked.filter((pending) => pending.seq > this.acked)
    this.sent = Math.max(this.sent, this.acked)
  }

  /** Everything unacknowledged goes out again. */
  rewind(): void {
    this.sent = this.acked
  }

  /** The entries not sent yet that the window allows, now counted as sent. */
  takeDue(window: number): { first: number; entries: JournalEntry[] } | null {
    const due = this.unacked.filter((pending) => pending.seq > this.sent && pending.seq <= this.acked + window)
    const [first] = due
    if (first === undefined) {
      return null
    }
    this.sent = first.seq + due.length - 1
    return { first: first.seq, entries: due.map((pending) => pending.entry) }
  }
}

/** Where an agent's journal stands, as the node tells the control plane when the link comes up. */
export interface JournalPosition {
  agent: string
  epoch: string
  /** The highest number the control plane acknowledged before the link dropped. */
  acked: number
  last: number
}

/**
 * The node's side of the journal: each agent's entries get an epoch and a sequence number, go out
 * in a bounded window, and are kept until acknowledged, so a dropped link loses nothing.
 */
export class JournalOutbox {
  private readonly journals = new Map<string, AgentJournal>()
  private online = true

  private readonly send: (frame: JournalAppend) => void
  private readonly window: number

  constructor(send: (frame: JournalAppend) => void, window = JOURNAL_WINDOW) {
    this.send = send
    this.window = window
  }

  /** Numbers the entry and sends it when the window allows; returns its number. */
  append(agent: string, entry: JournalEntry): number {
    const journal = this.journalOf(agent)
    const seq = journal.add(entry)
    this.flush(agent, journal)
    return seq
  }

  /** Drops what the control plane stored and sends what the window now allows. */
  reply(frame: JournalReply): void {
    const journal = this.journals.get(frame.agent)
    if (journal?.epoch !== frame.epoch) {
      return
    }
    if (frame.type === 'journal.reject') {
      journal.refused = frame.reason
      return
    }
    journal.acknowledge(frame.seq)
    this.flush(frame.agent, journal)
  }

  /** The link dropped: nothing goes out until it is back. */
  disconnected(): void {
    this.online = false
  }

  /** Where each journal stands, for the hello that brings the link back. */
  positions(): JournalPosition[] {
    return [...this.journals].map(([agent, { epoch, acked, next }]) => ({ agent, epoch, acked, last: next - 1 }))
  }

  /** The link is back: drops what the control plane already has and sends the rest again. */
  resume(cursors: ReadonlyMap<string, { epoch: string; seq: number }>): void {
    this.online = true
    for (const [agent, journal] of this.journals) {
      const cursor = cursors.get(agent)
      if (cursor?.epoch === journal.epoch) {
        journal.acknowledge(cursor.seq)
      }
      journal.rewind()
      this.flush(agent, journal)
    }
  }

  /** Why the control plane refused the agent's journal, or null. */
  refusal(agent: string): string | null {
    return this.journals.get(agent)?.refused ?? null
  }

  private journalOf(agent: string): AgentJournal {
    const existing = this.journals.get(agent)
    if (existing !== undefined) {
      return existing
    }
    const journal = new AgentJournal()
    this.journals.set(agent, journal)
    return journal
  }

  private flush(agent: string, journal: AgentJournal): void {
    const due = this.online && journal.refused === null ? journal.takeDue(this.window) : null
    if (due !== null) {
      this.send({ type: 'journal.append', agent, epoch: journal.epoch, ...due })
    }
  }
}

interface WaitingAsk {
  frame: AskFrame
  resolve: (answer: unknown) => void
  reject: (error: Error) => void
}

/** The node's side of asks: each waits for its answer and goes out again after a dropped link. */
export class AskOutbox {
  private readonly waiting = new Map<string, WaitingAsk>()

  private readonly send: (frame: AskFrame) => void

  constructor(send: (frame: AskFrame) => void) {
    this.send = send
  }

  /** Sends the ask and resolves with the control plane's answer, unchecked. */
  async ask(agent: string, ask: NodeAskType, body: unknown): Promise<unknown> {
    const frame: AskFrame = { type: 'ask', id: randomUUID(), agent, ask, body }
    return new Promise((resolve, reject) => {
      this.waiting.set(frame.id, { frame, resolve, reject })
      this.send(frame)
    })
  }

  reply(frame: AskReply): void {
    const waiting = this.waiting.get(frame.id)
    this.waiting.delete(frame.id)
    if (frame.type === 'ask.answer') {
      waiting?.resolve(frame.answer)
    } else {
      waiting?.reject(new Error(frame.error))
    }
  }

  /** The link is back: every ask still waiting goes out again with its own id. */
  resume(): void {
    for (const { frame } of this.waiting.values()) {
      this.send(frame)
    }
  }
}
