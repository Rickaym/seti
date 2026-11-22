import type { AskFrame, AskReply, JournalAppend, JournalEntry, JournalReply } from '@seti/shared'
import type { JournalPosition } from './node-outbox.js'

/** How long the control plane keeps an ask's answer, so a retried ask never runs twice. */
const ANSWER_KEEP_MS = 24 * 60 * 60 * 1000

/** A cursor as the control plane keeps it across its restarts. */
interface SavedCursor {
  agent: string
  epoch: string
  seq: number
}

/** Where the control plane stands in one agent's journal. */
class Cursor {
  readonly epoch: string
  /** The highest number received in order; entries up to it are applied or being applied. */
  received: number
  /** Resolves once every received entry is applied. */
  applied: Promise<void>
  /** Entries that arrived ahead of a gap, by number. */
  private readonly held = new Map<number, JournalEntry>()

  constructor(epoch: string, received: number, applied: Promise<void> = Promise.resolve()) {
    this.epoch = epoch
    this.received = received
    this.applied = applied
  }

  hold(seq: number, entry: JournalEntry): void {
    if (seq > this.received) {
      this.held.set(seq, entry)
    }
  }

  /** The held entries that now follow on without a gap, in order; they count as received. */
  takeReady(): { seq: number; entry: JournalEntry }[] {
    const ready: { seq: number; entry: JournalEntry }[] = []
    for (let entry = this.held.get(this.received + 1); entry !== undefined; entry = this.held.get(this.received + 1)) {
      this.received += 1
      this.held.delete(this.received)
      ready.push({ seq: this.received, entry })
    }
    return ready
  }

  /** Runs the work once everything received before it is applied. */
  then(work: () => Promise<void>): void {
    this.applied = this.applied.then(work)
  }
}

/**
 * The control plane's side of the journal. It applies each agent's entries once and in order,
 * whatever the link loses, repeats or reorders, and acknowledges them once applied.
 */
export class JournalInbox {
  private readonly cursors = new Map<string, Cursor>()
  private readonly apply: (agent: string, entry: JournalEntry) => Promise<void>
  private readonly reply: (frame: JournalReply) => void
  private readonly saved: (cursor: SavedCursor) => Promise<void>

  /** `saved` keeps each cursor before its entry is acknowledged, so a restart takes up from it. */
  constructor(
    apply: (agent: string, entry: JournalEntry) => Promise<void>,
    reply: (frame: JournalReply) => void,
    saved: (cursor: SavedCursor) => Promise<void> = async () => Promise.resolve(),
  ) {
    this.apply = apply
    this.reply = reply
    this.saved = saved
  }

  /** Takes up from the cursors kept before a restart; a node's hello is checked against them. */
  restore(saved: readonly SavedCursor[]): void {
    for (const { agent, epoch, seq } of saved) {
      this.cursors.set(agent, new Cursor(epoch, seq))
    }
  }

  /** What the node must send again from, per agent. */
  positions(): Map<string, { epoch: string; seq: number }> {
    return new Map([...this.cursors].map(([agent, cursor]) => [agent, { epoch: cursor.epoch, seq: cursor.received }]))
  }

  /**
   * Checks a journal the node reports as the link comes up. One with the expected epoch that
   * ends before what was already stored is an old copy, and is refused rather than merged.
   */
  hello(position: JournalPosition): boolean {
    const cursor = this.cursors.get(position.agent)
    if (cursor === undefined) {
      const { agent, epoch, acked } = position
      this.cursors.set(agent, new Cursor(epoch, acked))
      return true
    }
    if (cursor.epoch === position.epoch && position.last < cursor.received) {
      this.refuse(position.agent, position.epoch, 'The journal is older than what was stored')
      return false
    }
    return true
  }

  receive(frame: JournalAppend): void {
    const cursor = this.cursorFor(frame)
    if (cursor === null) {
      this.refuse(frame.agent, frame.epoch, 'Unknown journal epoch')
      return
    }
    frame.entries.forEach((entry, index) => {
      cursor.hold(frame.first + index, entry)
    })
    for (const { seq, entry } of cursor.takeReady()) {
      cursor.then(async () => this.applyOne(frame.agent, cursor.epoch, seq, entry))
    }
  }

  /** The agent's cursor for the run: a new journal starts at 1; any other must be the known one. */
  private cursorFor(frame: JournalAppend): Cursor | null {
    const cursor = this.cursors.get(frame.agent)
    if (cursor?.epoch === frame.epoch) {
      return cursor
    }
    if (cursor !== undefined && frame.first !== 1) {
      return null
    }
    const fresh = new Cursor(frame.epoch, 0, cursor?.applied)
    this.cursors.set(frame.agent, fresh)
    return fresh
  }

  private async applyOne(agent: string, epoch: string, seq: number, entry: JournalEntry): Promise<void> {
    try {
      await this.apply(agent, entry)
    } catch (e) {
      process.stderr.write(`node link: agent ${agent}: entry ${String(seq)} failed: ${String(e)}\n`)
    }
    try {
      await this.saved({ agent, epoch, seq })
    } catch (e) {
      process.stderr.write(`node link: agent ${agent}: cursor ${String(seq)} not kept: ${String(e)}\n`)
    }
    this.reply({ type: 'journal.ack', agent, epoch, seq })
  }

  private refuse(agent: string, epoch: string, reason: string): void {
    this.reply({ type: 'journal.reject', agent, epoch, reason })
  }
}

interface Answered {
  reply: Promise<AskReply>
  at: number
}

/** The control plane's side of asks: each ask id is answered once, and a retry gets that answer. */
export class AskLedger {
  private readonly answers = new Map<string, Answered>()
  private readonly answer: (frame: AskFrame) => Promise<unknown>
  private readonly now: () => number

  constructor(answer: (frame: AskFrame) => Promise<unknown>, now: () => number = Date.now) {
    this.answer = answer
    this.now = now
  }

  async receive(frame: AskFrame): Promise<AskReply> {
    this.forgetOld()
    const known = this.answers.get(frame.id)
    if (known !== undefined) {
      return known.reply
    }
    const reply = Promise.resolve(frame)
      .then(this.answer)
      .then(
        (answer): AskReply => ({ type: 'ask.answer', id: frame.id, answer }),
        (e: unknown): AskReply => ({
          type: 'ask.error',
          id: frame.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    this.answers.set(frame.id, { reply, at: this.now() })
    return reply
  }

  private forgetOld(): void {
    const oldest = this.now() - ANSWER_KEEP_MS
    for (const [id, answered] of this.answers) {
      if (answered.at < oldest) {
        this.answers.delete(id)
      }
    }
  }
}
