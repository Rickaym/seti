import { HttpError } from './http.js'
import { controlLink } from './node-link.js'
import { markQueued } from './queued-prompts.js'
import { inLane } from './task-lane.js'

const REFUSALS = {
  missing: 'That message is not waiting in the queue',
  unsupported: 'This Claude Code version cannot take back a queued message',
  taken: 'The agent already picked up that message',
}

/** Takes a message back from Claude Code's queue before the agent reads it. */
export async function removeQueued(taskId: string, promptId: number): Promise<void> {
  const { outcome, promptId: settled } = await controlLink.command('queued.retract', { agent: taskId, promptId })
  if (outcome !== 'removed') {
    throw new HttpError(409, REFUSALS[outcome])
  }
  if (settled !== null) {
    await inLane(taskId, async () => markQueued(taskId, settled, 'removed'))
  }
}
