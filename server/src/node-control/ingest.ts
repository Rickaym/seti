import type { JournalCursor, JournalEntry } from '@seti/shared'
import type { SessionView } from '../agent-session.js'
import type { CursorStore } from '../node-link/stores.js'
import { JOURNAL_ENTRIES, type JournalType } from '../session-host/link-kinds.js'
import type { ControlPort } from '../session-host/port.js'
import { nodeCursors } from '../store/nodes.js'

/** One agent's session as the node reported it in its hello, at that journal position. */
export interface SessionSnapshot {
  view: SessionView | null
  unstarted: { first: string | null } | null
  seq: number
}

const isType = (type: string): type is JournalType => Object.hasOwn(JOURNAL_ENTRIES, type)

type Apply = (port: ControlPort, taskId: string, body: never) => Promise<void> | void

interface TurnEndedBody {
  status: Parameters<ControlPort['turnEnded']>[1]
  error: string | null
}

/** What each journal entry does on the records side, through the same port the host calls. */
const APPLY: Record<JournalType, Apply> = {
  sdk: async (port, taskId, body: Parameters<ControlPort['message']>[1]) => port.message(taskId, body),
  queued: async (port, taskId, { promptId, state }: { promptId: number; state: 'delivered' | 'removed' }) =>
    port.queued(taskId, promptId, state),
  working: async (port, taskId) => port.working(taskId),
  'turn.ended': async (port, taskId, { status, error }: TurnEndedBody) => port.turnEnded(taskId, status, error),
  note: async (port, taskId, { error }: { error: string }) => port.note(taskId, error),
  rewound: async (port, taskId, { rewindId, refused }: { rewindId: number; refused: string | null }) =>
    port.rewound(taskId, rewindId, refused),
  'warm.opened': (port, taskId) => {
    port.warmOpened(taskId)
  },
  'session.changed': (port, taskId) => {
    port.sessionChanged(taskId)
  },
  'session.ended': (port, taskId) => {
    port.sessionEnded(taskId)
  },
  'session.closed': async (port, taskId, { since }: { since: number | null }) => port.sessionClosed(taskId, since),
  view: (port, taskId, { view }: { view: SessionView | null }) => {
    port.view(taskId, view)
  },
  unstarted: (port, taskId, { kept }: { kept: { first: string | null } | null }) => {
    port.unstarted(taskId, kept)
  },
}

/**
 * Stores what nodes journal: each entry is applied through the records side's port, in order per
 * agent, and the agent's cursor moves past it. Entries an older hello snapshot covered only move
 * the cursor for the view and kept messages, which the snapshot already set.
 */
export class NodeIngest implements CursorStore {
  private readonly port: ControlPort
  private readonly reached = new Map<string, number>()
  private readonly waiters = new Map<string, { seq: number; resolve: () => void }[]>()
  private readonly snapshotAt = new Map<string, number>()

  constructor(port: ControlPort) {
    this.port = port
  }

  async read(agent: string): Promise<JournalCursor | undefined> {
    return nodeCursors.get(agent)
  }

  async list(): Promise<Record<string, JournalCursor>> {
    return nodeCursors.all()
  }

  async commit(agent: string, epoch: string, entries: JournalEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.apply(agent, entry)
    }
    const last = entries.at(-1)?.seq
    if (last !== undefined) {
      await nodeCursors.set(agent, { epoch, seq: last })
      this.reach(agent, last)
    }
  }

  /** Replaces the mirror with the sessions a node reports in its hello. */
  applySnapshot(sessions: Readonly<Record<string, SessionSnapshot>>): void {
    for (const [taskId, snapshot] of Object.entries(sessions)) {
      this.snapshotAt.set(taskId, snapshot.seq)
      this.port.view(taskId, snapshot.view)
      this.port.unstarted(taskId, snapshot.unstarted)
    }
  }

  /** Resolves once the agent's journal is stored up to `seq`. */
  async reachedAt(taskId: string, seq: number): Promise<void> {
    if (!this.reached.has(taskId)) {
      this.reached.set(taskId, Math.max(this.reached.get(taskId) ?? 0, (await nodeCursors.get(taskId))?.seq ?? 0))
    }
    if ((this.reached.get(taskId) ?? 0) >= seq) {
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.set(taskId, [...(this.waiters.get(taskId) ?? []), { seq, resolve }])
    })
  }

  private reach(taskId: string, seq: number): void {
    this.reached.set(taskId, seq)
    const waiting = this.waiters.get(taskId) ?? []
    for (const waiter of waiting.filter((w) => w.seq <= seq)) {
      waiter.resolve()
    }
    this.waiters.set(
      taskId,
      waiting.filter((w) => w.seq > seq),
    )
  }

  private async apply(taskId: string, entry: JournalEntry): Promise<void> {
    const { type } = entry
    const covered = entry.seq <= (this.snapshotAt.get(taskId) ?? 0)
    if (!isType(type) || (covered && (type === 'view' || type === 'unstarted'))) {
      return
    }
    try {
      const body = JOURNAL_ENTRIES[type].parse(entry.body)
      await APPLY[type](this.port, taskId, body as never)
    } catch (e) {
      process.stderr.write(`node: task ${taskId}: could not store ${type} #${String(entry.seq)}: ${String(e)}\n`)
    }
  }
}
