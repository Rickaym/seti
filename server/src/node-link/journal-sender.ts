import type { JournalCursor, JournalEntry, NodeMessageOf } from '@seti/shared'
import type { OutgoingMessage } from './connection.js'
import type { LinkEventSink } from './events.js'
import type { AgentJournal, NodeJournal } from './journal.js'

export interface JournalSenderOptions {
  /** Batches sent and not yet acknowledged, across all agents; default 8. */
  window?: number
  /** Entries in one batch at most; default 100. */
  batchEntries?: number
  /** Bytes of entries in one batch at most, unless a single entry is larger; default 256 KiB. */
  batchBytes?: number
}

interface Flow {
  journal: AgentJournal
  next: number
  inFlight: { first: number; last: number }[]
  stopped: boolean
}

type Send = (message: OutgoingMessage) => void

/** The node's side of the journal: sends from the control plane's cursor, a window at a time. */
export class JournalSender {
  private readonly journal: NodeJournal
  private readonly events: LinkEventSink
  private readonly window: number
  private readonly batchEntries: number
  private readonly batchBytes: number
  private readonly flows = new Map<string, Flow>()
  private cursors: Record<string, JournalCursor> = {}
  private send: Send | null = null
  private generation = 0
  private pumping = false
  private again = false

  constructor(journal: NodeJournal, events: LinkEventSink, options: JournalSenderOptions = {}) {
    this.journal = journal
    this.events = events
    this.window = options.window ?? 8
    this.batchEntries = options.batchEntries ?? 100
    this.batchBytes = options.batchBytes ?? 256 * 1024
    journal.onAppend(() => {
      this.pump()
    })
  }

  /** Starts sending on a new connection from the cursors in the welcome. */
  attach(send: Send, cursors: Record<string, JournalCursor>): void {
    this.detach()
    this.send = send
    this.cursors = cursors
    this.pump()
  }

  detach(): void {
    this.send = null
    this.generation += 1
    this.flows.clear()
  }

  ack(message: NodeMessageOf<'journal.ack'>): void {
    const flow = this.flows.get(message.agent)
    if (flow?.journal.epoch !== message.epoch) {
      return
    }
    flow.inFlight = flow.inFlight.filter((batch) => batch.last > message.seq)
    flow.journal.acknowledge(message.seq)
    this.pump()
  }

  /** Replays from the receiver's cursor after a gap; any other refusal stops that agent. */
  reject(message: NodeMessageOf<'journal.reject'>): void {
    const flow = this.flows.get(message.agent)
    if (flow === undefined || flow.stopped) {
      return
    }
    const { cursor, first } = message
    if (message.reason === 'gap' && cursor !== undefined) {
      if (flow.inFlight.some((batch) => batch.first === first)) {
        flow.inFlight = []
        flow.next = cursor.seq + 1
        this.pump()
      }
      return
    }
    flow.stopped = true
    this.events({ type: 'journal-stopped', agent: message.agent, reason: message.reason })
  }

  private pump(): void {
    if (this.pumping) {
      this.again = true
      return
    }
    this.pumping = true
    void this.fill()
      .catch((error: unknown) => {
        this.events({ type: 'journal-error', message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        this.pumping = false
        if (this.again) {
          this.again = false
          this.pump()
        }
      })
  }

  private inFlight(): number {
    let count = 0
    for (const flow of this.flows.values()) {
      count += flow.inFlight.length
    }
    return count
  }

  private flowFor(journal: AgentJournal): Flow {
    const existing = this.flows.get(journal.agent)
    if (existing !== undefined) {
      return existing
    }
    const cursor = this.cursors[journal.agent]
    if (cursor?.epoch === journal.epoch) {
      journal.acknowledge(cursor.seq)
    }
    const next = cursor === undefined ? journal.firstSeq : cursor.seq + 1
    const flow: Flow = { journal, next, inFlight: [], stopped: false }
    this.flows.set(journal.agent, flow)
    return flow
  }

  private async fill(): Promise<void> {
    const generation = this.generation
    for (const journal of await this.journal.list()) {
      if (generation !== this.generation) {
        return
      }
      const flow = this.flowFor(journal)
      while (!flow.stopped && this.inFlight() < this.window && journal.lastSeq >= flow.next) {
        const from = flow.next
        const entries = await journal.read(from - 1, this.batchEntries)
        if (generation !== this.generation) {
          return
        }
        if (flow.next === from && !this.sendBatch(journal.agent, entries)) {
          break
        }
      }
    }
  }

  private sendBatch(agent: string, entries: JournalEntry[]): boolean {
    const flow = this.flows.get(agent)
    const batch = this.trim(entries)
    const [head] = batch
    const tail = batch.at(-1)
    if (this.send === null || flow === undefined || head === undefined || tail === undefined) {
      return false
    }
    const { epoch } = flow.journal
    if (head.seq !== flow.next) {
      flow.stopped = true
      this.events({ type: 'journal-stopped', agent, reason: `entries before ${String(head.seq)} are gone` })
      return false
    }
    this.send({ type: 'journal.append', agent, epoch, first: head.seq, entries: batch })
    flow.inFlight.push({ first: head.seq, last: tail.seq })
    flow.next = tail.seq + 1
    return true
  }

  private trim(entries: JournalEntry[]): JournalEntry[] {
    let bytes = 0
    const kept: JournalEntry[] = []
    for (const entry of entries) {
      bytes += JSON.stringify(entry).length
      if (kept.length > 0 && bytes > this.batchBytes) {
        break
      }
      kept.push(entry)
    }
    return kept
  }
}
