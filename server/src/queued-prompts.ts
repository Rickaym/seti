import type { QueueState } from '@seti/shared'
import type { LiveSession } from './agent-session.js'
import { messages } from './db.js'
import { nodeLink } from './node-link.js'
import type { InputReport } from './runtimes/adapter.js'
import { publish } from './task-events.js'

/** Marks a queued prompt delivered or removed, once, and tells open transcripts. */
export async function markQueued(
  taskId: string,
  promptId: number,
  state: Exclude<QueueState, 'waiting'>,
): Promise<void> {
  const row = (await messages.settleQueued(taskId, promptId, state)) ? await messages.get(taskId, promptId) : undefined
  if (row) {
    publish(taskId, { type: 'updated', row })
  }
}

/** Records where a message the session queued went, if it was still waiting. */
export async function settleQueued(
  taskId: string,
  session: LiveSession,
  uuid: string,
  state: Exclude<QueueState, 'waiting'>,
): Promise<void> {
  const promptId = session.settle(uuid)
  if (promptId !== null) {
    await nodeLink.journal(taskId, { type: 'queued.settled', promptId, state })
  }
}

/** Follows the runtime's report on an input it queued: queued, handed to the agent, or dropped. */
export async function followInput(taskId: string, session: LiveSession, { id, state }: InputReport): Promise<void> {
  if (state === 'queued') {
    session.arrived(id)
  } else if (state === 'started') {
    await settleQueued(taskId, session, id, 'delivered')
  } else if (state === 'cancelled') {
    await settleQueued(taskId, session, id, 'removed')
  }
}
