import { HttpError } from './http.js'
import { markQueued } from './queued-prompts.js'
import { cancelQueuedPrompt } from './session-controls.js'
import { inLane } from './task-lane.js'

/** Takes a message back from Claude Code's queue before the agent reads it. */
export async function removeQueued(taskId: string, promptId: number): Promise<void> {
  const outcome = await cancelQueuedPrompt(taskId, promptId)
  if (outcome === 'not_queued') {
    throw new HttpError(409, 'That message is not waiting in the queue')
  }
  if (outcome === 'unsupported') {
    throw new HttpError(409, 'This Claude Code version cannot take back a queued message')
  }
  if (outcome === 'picked_up') {
    throw new HttpError(409, 'The agent already picked up that message')
  }
  const settled = outcome.taken
  if (settled !== null) {
    await inLane(taskId, async () => markQueued(taskId, settled, 'removed'))
  }
}
