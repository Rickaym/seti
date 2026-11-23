import { AsyncLocalStorage } from 'node:async_hooks'
import type { AskCancel, AskFrame, AskReply, JournalAppend, JournalEntry, JournalReply } from '@seti/shared'
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

  /** Waits for entries not received yet, each woken once its entry is applied. */
  private waiters: { seq: number; wake: () => void }[] = []

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

  /** Resolves once the entry `seq` is applied, or once this journal is replaced. */
  async reached(seq: number): Promise<void> {
    if (seq <= this.received) {
      return this.applied
    }
    return new Promise((wake) => {
      this.waiters.push({ seq, wake })
    })
  }

  /** Wakes the waits whose entries are now received, once those are applied. */
  wakeReceived(): void {
    const due = this.waiters.filter(({ seq }) => seq <= this.received)
    this.waiters = this.waiters.filter(({ seq }) => seq > this.received)
    for (const { wake } of due) {
      void this.applied.then(wake)
    }
  }

  /** The journal is replaced or refused: nothing more of it arrives, so no wait goes on. */
  release(): void {
    for (const { wake } of this.waiters.splice(0)) {
      wake()
    }
  }
}

/**
 * The control plane's side of the journal. It applies each agent's entries once and in order,
 * whatever the link loses, repeats or reorders, and acknowledges them once applied.
 */
export class JournalInbox {
  private readonly cursors = new Map<string, Cursor>()

  /** The agent whose entry is being applied, for work that entry starts. */
  private readonly applying = new AsyncLocalStorage<string>()
  private readonly apply: (agent: string, entry: JournalEntry) => Promise<void>
  private readonly reply: (frame: JournalReply) => void
  private readonly saved: (cursor: SavedCursor) => Promise<void>

  /** `saved` keeps each cursor before its entry is applied, so a restart takes up after it. */
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

  /** True inside the apply of an entry, which must not wait for the entries after it. */
  inApply(): boolean {
    return this.applying.getStore() !== undefined
  }

  /** Resolves once the agent's entries up to `mark` are applied, or its journal is replaced. */
  async applied(mark: SavedCursor): Promise<void> {
    const cursor = this.cursors.get(mark.agent)
    if (cursor?.epoch === mark.epoch) {
      await cursor.reached(mark.seq)
    }
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
    cursor.wakeReceived()
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
    cursor?.release()
    this.cursors.set(frame.agent, fresh)
    return fresh
  }

  /**
   * Keeps the cursor before applying, so a crash during the apply never applies the entry twice:
   * a restart takes up after it, as a crash of the single process loses what it was storing.
   */
  private async applyOne(agent: string, epoch: string, seq: number, entry: JournalEntry): Promise<void> {
    try {
      await this.saved({ agent, epoch, seq })
    } catch (e) {
      process.stderr.write(`node link: agent ${agent}: cursor ${String(seq)} not kept: ${String(e)}\n`)
    }
    try {
      await this.applying.run(agent, async () => this.apply(agent, entry))
    } catch (e) {
      process.stderr.write(`node link: agent ${agent}: entry ${String(seq)} failed: ${String(e)}\n`)
    }
    this.reply({ type: 'journal.ack', agent, epoch, seq })
  }

  private refuse(agent: string, epoch: string, reason: string): void {
    const cursor = this.cursors.get(agent)
    if (cursor?.epoch === epoch) {
      cursor.release()
    }
    this.reply({ type: 'journal.reject', agent, epoch, reason })
  }
}

interface Answered {
  reply: Promise<AskReply>
  at: number
  abort: AbortController
}

/** The control plane's side of asks: each ask id is answered once, and a retry gets that answer. */
export class AskLedger {
  private readonly answers = new Map<string, Answered>()
  private readonly answer: (frame: AskFrame, signal: AbortSignal) => Promise<unknown>
  private readonly now: () => number

  constructor(answer: (frame: AskFrame, signal: AbortSignal) => Promise<unknown>, now: () => number = Date.now) {
    this.answer = answer
    this.now = now
  }

  async receive(frame: AskFrame): Promise<AskReply> {
    this.forgetOld()
    const known = this.answers.get(frame.id)
    if (known !== undefined) {
      return known.reply
    }
    const abort = new AbortController()
    const reply = Promise.resolve(frame)
      .then(async (asked) => this.answer(asked, abort.signal))
      .then(
        (answer): AskReply => ({ type: 'ask.answer', id: frame.id, answer }),
        (e: unknown): AskReply => ({
          type: 'ask.error',
          id: frame.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    this.answers.set(frame.id, { reply, at: this.now(), abort })
    return reply
  }

  /** The node stopped waiting: the answer in progress is aborted. */
  cancel({ id }: AskCancel): void {
    this.answers.get(id)?.abort.abort(new Error('The node stopped waiting for this answer'))
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
