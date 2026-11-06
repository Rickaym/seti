import type { NextMessage } from './agent-session.js'
import { HttpError } from './http.js'
import { shellTurnGuard } from './shell-context.js'
import { pendingPrefaces } from './turn-prompt.js'

/** Refuses what cannot go to the agent now; returns how many updates the message carries. */
export async function checkSend(
  taskId: string,
  message: Omit<NextMessage, 'interrupted'>,
  running: boolean,
): Promise<number> {
  const { prompt } = message
  if (running && message.retry === true) {
    throw new HttpError(409, 'The agent is working. Wait for its turn to end before retrying.')
  }
  if (running && prompt?.trimStart().startsWith('/') === true) {
    throw new HttpError(409, 'Slash commands wait until the agent finishes its turn')
  }
  const shell = shellTurnGuard(taskId)
  if (shell !== null) {
    throw new HttpError(409, shell)
  }
  const count = await pendingPrefaces(taskId, prompt)
  if (prompt === null && count === 0) {
    throw new HttpError(409, 'Nothing is waiting for the agent')
  }
  return count
}
