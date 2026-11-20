import type { NodeMessageOf } from '@seti/shared'
import type { OutgoingMessage } from './connection.js'
import type { LinkEventSink } from './events.js'
import type { CursorStore } from './stores.js'

type Batch = NodeMessageOf<'journal.append'>
type Reply = (message: OutgoingMessage) => void

/** The control plane's side of the journal: stores each entry once, in order, per epoch. */
export class JournalReceiver {
  private readonly store: CursorStore
  private readonly events: LinkEventSink
  private readonly chains = new Map<string, Promise<void>>()

  constructor(store: CursorStore, events: LinkEventSink) {
    this.store = store
    this.events = events
  }

  /** Applies batches of one agent one at a time; rejects when the store fails. */
  async receive(batch: Batch, reply: Reply): Promise<void> {
    const previous = this.chains.get(batch.agent) ?? Promise.resolve()
    const run = previous.then(async () => this.apply(batch, reply))
    this.chains.set(
      batch.agent,
      run.catch(() => undefined),
    )
    return run
  }

  private async apply(batch: Batch, reply: Reply): Promise<void> {
    const { agent, epoch, first } = batch
    const cursor = (await this.store.read(agent)) ?? { epoch, seq: 0 }
    if (cursor.epoch !== epoch) {
      reply({ type: 'journal.reject', agent, reason: 'epoch', first, cursor })
      this.events({ type: 'journal-stopped', agent, reason: 'epoch' })
      return
    }
    if (first > cursor.seq + 1) {
      reply({ type: 'journal.reject', agent, reason: 'gap', first, cursor })
      return
    }
    const fresh = batch.entries.filter((entry) => entry.seq > cursor.seq)
    if (fresh.length > 0) {
      await this.store.commit(agent, epoch, fresh)
    }
    reply({ type: 'journal.ack', agent, epoch, seq: Math.max(cursor.seq, first + batch.entries.length - 1) })
  }
}
