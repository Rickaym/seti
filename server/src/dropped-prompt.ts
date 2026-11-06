import { RESENT_NOTE, type TaskStatus } from '@seti/shared'
import type { SendOutcome } from './agent-session.js'
import { refuseArchived } from './archive-guard.js'
import { inBackground } from './background.js'
import { messages, tasks } from './db.js'
import { HttpError } from './http.js'
import { appendMessage, isRunning, openWarmSession, runTurn, sessionState } from './runner.js'
import { inLane } from './task-lane.js'
import { firstUnstarted } from './unstarted.js'

/** How long a turn that never called the model may sit unanswered before its message goes again. */
const RECHECK_MS = 8000

/** Sends the task's last message again, once, when Claude Code ended the turn without reading it. */
export async function resendDroppedPrompt(taskId: string): Promise<boolean> {
  if (isRunning(taskId)) {
    return false
  }
  const dropped = await messages.droppedPrompt(taskId, RESENT_NOTE)
  if (dropped === null) {
    return false
  }
  await inLane(taskId, async () => appendMessage(taskId, { kind: 'seti', payload: { error: RESENT_NOTE } }))
  await runTurn(taskId, dropped.text, { attachments: dropped.attachments, from: dropped.from })
  return true
}

/** Opens a session for the messages a failed start kept; the first one's text, or null if none. */
async function retryUnstarted(taskId: string): Promise<string | null> {
  return inLane(taskId, async () => {
    const first = firstUnstarted(taskId)
    const task = await tasks.get(taskId)
    if (first === null || task === undefined || sessionState(taskId).open) {
      return null
    }
    refuseArchived(task)
    await openWarmSession(taskId)
    return first
  })
}

/**
 * Sends the task's last message again, unchanged and marked with who wrote it, as after a failed
 * turn. After a session that could not start, the messages it kept go instead.
 */
export async function retryLastPrompt(taskId: string): Promise<{ prompt: string; outcome: SendOutcome }> {
  const kept = await retryUnstarted(taskId)
  if (kept !== null) {
    return { prompt: kept, outcome: 'started' }
  }
  const last = await messages.lastPrompt(taskId)
  if (last === null) {
    throw new HttpError(409, 'The agent has no message to send again.')
  }
  const outcome = await runTurn(taskId, last.text, { attachments: last.attachments, retry: true, from: last.from })
  return { prompt: last.text, outcome }
}

/** Checks an idle task again shortly after its turn ends, since a late answer may still come. */
export function watchDroppedPrompts(taskId: string, status: TaskStatus, delayMs = RECHECK_MS): void {
  if (status !== 'idle') {
    return
  }
  setTimeout(() => {
    inBackground(`could not resend a dropped prompt of task ${taskId}`, async () => resendDroppedPrompt(taskId))
  }, delayMs).unref()
}
