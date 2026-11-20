import fs from 'node:fs/promises'
import path from 'node:path'
import type { JournalEntry } from '@seti/shared'
import { readOrCreateEpoch, readSegment, scanSegments, segmentFile, syncDir, type Segment } from './journal-files.js'

const AGENT_ID = /^[A-Za-z0-9][\w.-]{0,127}$/
const DAY_MS = 24 * 60 * 60 * 1000
const MIB = 1024 * 1024

export interface JournalOptions {
  /** A new file starts once the current one would pass this size; default 1 MiB. */
  maxSegmentBytes?: number
  /** Prune deletes acknowledged files whose last write is older than this; default a day. */
  pruneAfterMs?: number
  now?: () => number
}

/** What a caller appends; the journal adds the sequence number, and the time unless given. */
export interface JournalItem {
  type: string
  body: unknown
  at?: number
}

interface Active {
  segment: Segment
  handle: fs.FileHandle
}

interface AgentJournalInit {
  agent: string
  dir: string
  epoch: string
  segments: Segment[]
  options: JournalOptions
  notify: (journal: AgentJournal) => void
}

/** One agent's durable journal: an entry counts as appended once it is written and fsynced. */
export class AgentJournal {
  readonly agent: string
  readonly epoch: string
  private readonly dir: string
  private readonly maxSegmentBytes: number
  private readonly pruneAfterMs: number
  private readonly now: () => number
  private readonly notify: (journal: AgentJournal) => void
  private segments: Segment[]
  private active: Active | null = null
  private last: number
  private acked = 0
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(init: AgentJournalInit) {
    this.agent = init.agent
    this.epoch = init.epoch
    this.dir = init.dir
    this.segments = init.segments
    this.maxSegmentBytes = init.options.maxSegmentBytes ?? MIB
    this.pruneAfterMs = init.options.pruneAfterMs ?? DAY_MS
    this.now = init.options.now ?? Date.now
    this.notify = init.notify
    this.last = init.segments.at(-1)?.last ?? 0
  }

  /** The sequence number of the newest appended entry, 0 when there is none. */
  get lastSeq(): number {
    return this.last
  }

  /** The oldest sequence number still on disk. */
  get firstSeq(): number {
    return this.segments[0]?.first ?? this.last + 1
  }

  async append(items: JournalItem[]): Promise<JournalEntry[]> {
    return this.serial(async () => this.write(items))
  }

  /** Up to `limit` entries after sequence number `after`, oldest first. */
  async read(after: number, limit: number): Promise<JournalEntry[]> {
    const upTo = this.last
    const entries: JournalEntry[] = []
    for (const segment of this.segments) {
      if (entries.length >= limit) {
        break
      }
      if (segment.last > after) {
        entries.push(...(await readSegment(segment, after, upTo)))
      }
    }
    return entries.slice(0, limit)
  }

  /** Records that the control plane stored everything up to `seq`. */
  acknowledge(seq: number): void {
    this.acked = Math.max(this.acked, Math.min(seq, this.last))
  }

  /** Deletes acknowledged files older than the prune age; the newest file always stays. */
  async prune(): Promise<number> {
    return this.serial(async () => {
      const cutoff = this.now() - this.pruneAfterMs
      const newest = this.segments.at(-1)
      const kept: Segment[] = []
      for (const segment of this.segments) {
        const removable = segment !== newest && segment !== this.active?.segment && segment.last <= this.acked
        if (removable && (await fs.stat(segment.file)).mtimeMs < cutoff) {
          await fs.unlink(segment.file)
        } else {
          kept.push(segment)
        }
      }
      const removed = this.segments.length - kept.length
      this.segments = kept
      return removed
    })
  }

  async close(): Promise<void> {
    await this.serial(async () => {
      this.closed = true
      await this.active?.handle.close()
      this.active = null
    })
  }

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work)
    this.tail = run.catch(() => undefined)
    return run
  }

  private async write(items: JournalItem[]): Promise<JournalEntry[]> {
    if (this.closed) {
      throw new Error(`journal ${this.agent} is closed`)
    }
    const at = this.now()
    const entries = items.map((item, index) => ({
      seq: this.last + 1 + index,
      at: item.at ?? at,
      type: item.type,
      body: item.body,
    }))
    const newest = entries.at(-1)
    if (newest === undefined) {
      return []
    }
    const text = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')
    const { segment, handle } = await this.activeFor(Buffer.byteLength(text))
    try {
      await handle.appendFile(text)
      await handle.sync()
    } catch (error) {
      await handle.truncate(segment.bytes).catch(() => undefined)
      throw error
    }
    segment.bytes += Buffer.byteLength(text)
    segment.last = newest.seq
    this.last = newest.seq
    this.notify(this)
    return entries
  }

  private async activeFor(bytes: number): Promise<Active> {
    const current = this.active
    if (current !== null && (current.segment.bytes === 0 || current.segment.bytes + bytes <= this.maxSegmentBytes)) {
      return current
    }
    await current?.handle.close()
    const first = this.last + 1
    const segment: Segment = { first, last: this.last, file: segmentFile(this.dir, first), bytes: 0 }
    const handle = await fs.open(segment.file, 'a', 0o600)
    await syncDir(this.dir)
    this.segments = [...this.segments.filter((other) => other.first !== first), segment]
    this.active = { segment, handle }
    return this.active
  }
}

/** Every agent's journal under one directory, one subdirectory per agent. */
export class NodeJournal {
  private readonly dir: string
  private readonly options: JournalOptions
  private readonly journals = new Map<string, Promise<AgentJournal>>()
  private readonly listeners = new Set<(journal: AgentJournal) => void>()

  private constructor(dir: string, options: JournalOptions) {
    this.dir = dir
    this.options = options
  }

  /** Opens the journals already under `dir`, creating it when missing. */
  static async open(dir: string, options: JournalOptions = {}): Promise<NodeJournal> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const journal = new NodeJournal(dir, options)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && AGENT_ID.test(entry.name))
        .map(async (entry) => journal.agent(entry.name)),
    )
    return journal
  }

  /** The journal of `agent`, created with a new epoch the first time. */
  async agent(agent: string): Promise<AgentJournal> {
    if (!AGENT_ID.test(agent)) {
      throw new Error('not a valid journal agent id')
    }
    let opening = this.journals.get(agent)
    if (opening === undefined) {
      opening = this.openAgent(agent)
      this.journals.set(agent, opening)
      void opening.catch(() => this.journals.delete(agent))
    }
    return opening
  }

  /** The journals opened so far. */
  async list(): Promise<AgentJournal[]> {
    return Promise.all(this.journals.values())
  }

  /** Calls `listener` after every append to any journal; returns the unsubscribe. */
  onAppend(listener: (journal: AgentJournal) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prune(): Promise<number> {
    const removed = await Promise.all((await this.list()).map(async (journal) => journal.prune()))
    return removed.reduce((sum, count) => sum + count, 0)
  }

  async close(): Promise<void> {
    await Promise.all((await this.list()).map(async (journal) => journal.close()))
  }

  private async openAgent(agent: string): Promise<AgentJournal> {
    const dir = path.join(this.dir, agent)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const epoch = await readOrCreateEpoch(dir)
    const segments = await scanSegments(dir)
    const notify = (journal: AgentJournal) => {
      for (const listener of this.listeners) {
        listener(journal)
      }
    }
    return new AgentJournal({ agent, dir, epoch, segments, options: this.options, notify })
  }
}
