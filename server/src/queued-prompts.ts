import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueueState } from '@seti/shared'
import { z } from 'zod'
import type { LiveSession } from './agent-session.js'
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

/** Records where a message the session queued went, if it was still waiting. */
export async function settleQueued(
  taskId: string,
  session: LiveSession,
  uuid: string,
  state: Exclude<QueueState, 'waiting'>,
): Promise<void> {
  const promptId = session.settle(uuid)
  if (promptId !== null) {
    await markQueued(taskId, promptId, state)
  }
}

const commandLifecycle = z.object({
  type: z.literal('command_lifecycle'),
  command_uuid: z.string(),
  state: z.string(),
})

/**
 * Follows Claude Code's reports on the messages it queued, which the SDK types leave out; true
 * for such a report, which is bookkeeping rather than transcript.
 */
export async function followQueue(taskId: string, session: LiveSession, m: SDKMessage): Promise<boolean> {
  const report = commandLifecycle.safeParse(m)
  if (!report.success) {
    return false
  }
  const { command_uuid: uuid, state } = report.data
  if (state === 'queued') {
    session.arrived(uuid)
  } else if (state === 'started') {
    await settleQueued(taskId, session, uuid, 'delivered')
  } else if (state === 'cancelled') {
    await settleQueued(taskId, session, uuid, 'removed')
  }
  return true
}
