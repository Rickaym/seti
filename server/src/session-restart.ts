import type { Task } from '@seti/shared'
import { auditTask } from './audit.js'
import { HttpError } from './http.js'
import {
  appendMessage,
  endSession,
  isRunning,
  openWarmSession,
  sessionState,
  stopTurn,
  type TurnPreface,
} from './runner.js'
import { sessionRestarts } from './store/processes.js'
import { inLane } from './task-lane.js'

const NOTE = 'Session restarted; the conversation continues'

const PREFACE =
  'The user restarted your Claude Code session from Seti, so your tools, MCP servers and plugins ' +
  'were loaded again. The conversation continues, but background shells, processes and subagents ' +
  'you started before the restart have ended; start again any you still need.'

/** The latest restart since the agent last read a message, so it knows what ended with it. */
export async function restartPreface(taskId: string): Promise<TurnPreface | null> {
  return (await sessionRestarts.sinceLastTurn(taskId)) ? { text: PREFACE, count: 1 } : null
}

/**
 * Ends the task's Claude Code process with everything running in it, and opens a new one at once
 * that resumes the conversation. A running turn is refused unless `interrupt`, which stops it
 * first.
 */
export async function restartSession(task: Task, input: { interrupt: boolean }): Promise<void> {
  const interrupted = isRunning(task.id)
  if (interrupted && !input.interrupt) {
    throw new HttpError(409, 'The agent is working. Stop its turn and restart, or wait until it finishes.')
  }
  if (interrupted) {
    await stopTurn(task.id)
  }
  await endSession(task.id)
  await inLane(task.id, async () => {
    await appendMessage(task.id, { kind: 'seti', payload: { error: NOTE, session: 'restarted' } })
    if (!sessionState(task.id).open) {
      await openWarmSession(task.id)
    }
  })
  await auditTask('task.session_restarted', task, { interrupted })
}
