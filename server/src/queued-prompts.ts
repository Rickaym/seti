import type { QueueState } from '@seti/shared'
import { messages } from './db.js'
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
