import { randomUUID } from 'node:crypto'
import type { JournalType, PortAsk } from './link-kinds.js'
import type { ControlPort, SessionStartSpec } from './port.js'
import type { NodeJournal } from '../node-link/journal.js'
import type { LinkPeer } from '../node-link/link.js'

/** Appends to each agent's journal in call order; resolves with the entry's sequence number. */
export class JournalWriter {
  private readonly journal: NodeJournal
  private readonly tails = new Map<string, Promise<number>>()

  constructor(journal: NodeJournal) {
    this.journal = journal
  }

  async append(taskId: string, type: JournalType, body: object = {}): Promise<number> {
    const previous = this.tails.get(taskId) ?? Promise.resolve(0)
    const next = previous
      .catch(() => 0)
      .then(async () => {
        const [entry] = await (await this.journal.agent(taskId)).append([{ type, body }])
        return entry?.seq ?? 0
      })
    this.tails.set(taskId, next)
    return next
  }

  /** The newest sequence number of the agent's journal once every append so far is written. */
  async lastSeq(taskId: string): Promise<number> {
    await (this.tails.get(taskId) ?? Promise.resolve(0)).catch(() => 0)
    return (await this.journal.agent(taskId)).lastSeq
  }

  /** Appends without waiting; a failure is logged, since nothing can take the entry back. */
  post(taskId: string, type: JournalType, body: object = {}): void {
    this.append(taskId, type, body).catch((e: unknown) => {
      process.stderr.write(`node: task ${taskId}: could not journal ${type}: ${String(e)}\n`)
    })
  }
}

/** Asks the records side and waits for its answer, which may come after a reconnect. */
async function askOver(peer: LinkPeer, kind: PortAsk, taskId: string, body: object): Promise<unknown> {
  const reply = await peer.ask({ id: randomUUID(), kind, agent: taskId, body })
  if (reply.kind !== 'answer') {
    throw new Error(`Seti did not answer the ${kind} ask of task ${taskId}`)
  }
  return reply.body
}

/**
 * The records side as a node reaches it: what it tells goes to the agent's journal on disk first,
 * and what it asks waits until the records side has stored the journal up to that point.
 */
export function linkControlPort(peer: LinkPeer, writer: JournalWriter): ControlPort {
  const ask = async (kind: PortAsk, taskId: string, body: object = {}) =>
    askOver(peer, kind, taskId, { ...body, after: await writer.lastSeq(taskId) })
  return {
    openTurn: async (taskId, next, queued) =>
      (await ask('turn.open', taskId, { next, queued })) as Awaited<ReturnType<ControlPort['openTurn']>>,
    sessionSpec: async (taskId) => (await ask('session.spec', taskId)) as SessionStartSpec,
    taskExists: async (taskId) => (await ask('task.exists', taskId)) === true,
    opening: async (taskId) => {
      await ask('session.opening', taskId)
    },
    message: async (taskId, message) => {
      await writer.append(taskId, 'sdk', message)
    },
    queued: async (taskId, promptId, state) => {
      await writer.append(taskId, 'queued', { promptId, state })
    },
    working: async (taskId) => {
      await writer.append(taskId, 'working')
    },
    turnEnded: async (taskId, status, error) => {
      await writer.append(taskId, 'turn.ended', { status, error })
    },
    note: async (taskId, error) => {
      await writer.append(taskId, 'note', { error })
    },
    rewound: async (taskId, rewindId, refused) => {
      await writer.append(taskId, 'rewound', { rewindId, refused })
    },
    warmOpened: (taskId) => {
      writer.post(taskId, 'warm.opened')
    },
    sessionChanged: (taskId) => {
      writer.post(taskId, 'session.changed')
    },
    sessionEnded: (taskId) => {
      writer.post(taskId, 'session.ended')
    },
    sessionClosed: async (taskId, since) => {
      await writer.append(taskId, 'session.closed', { since })
    },
    view: (taskId, view) => {
      writer.post(taskId, 'view', { view })
    },
    unstarted: (taskId, kept) => {
      writer.post(taskId, 'unstarted', { kept })
    },
  }
}
