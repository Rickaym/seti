import { HttpError } from './http.js'
import { markQueued } from './queued-prompts.js'
import { liveSessions } from './runner.js'
import { inLane } from './task-lane.js'

/** Takes a message back from Claude Code's queue before the agent reads it. */
export async function removeQueued(taskId: string, promptId: number): Promise<void> {
  const session = liveSessions().find(([id]) => id === taskId)?.[1]
  const uuid = session?.uuidOf(promptId) ?? null
  if (session === undefined || uuid === null) {
    throw new HttpError(409, 'That message is not waiting in the queue')
  }
  const cancelled = await session.cancelQueued(uuid)
  if (cancelled === null) {
    throw new HttpError(409, 'This Claude Code version cannot take back a queued message')
  }
  if (!cancelled) {
    throw new HttpError(409, 'The agent already picked up that message')
  }
  const settled = session.settle(uuid)
  if (settled !== null) {
    await inLane(taskId, async () => markQueued(taskId, settled, 'removed'))
  }
}
