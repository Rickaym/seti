import type { SessionRestart, Task } from '@seti/shared'
import { auditTask } from './audit.js'
import { tasks } from './db.js'
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

const NOTES: Record<SessionRestart, string> = {
  restarted: 'Session restarted; the conversation continues',
  fresh: 'Fresh session started; the agent no longer has the conversation above',
}

const PREFACES: Record<SessionRestart, string> = {
  restarted:
    'The user restarted your Claude Code session from Seti, so your tools, MCP servers and plugins ' +
    'were loaded again. The conversation continues, but background shells, processes and subagents ' +
    'you started before the restart have ended; start again any you still need.',
  fresh:
    'The user started you in a fresh Claude Code session from Seti, so the earlier conversation of ' +
    'this task is not in your context. Your task.md and workspace describe the task. Background ' +
    'shells, processes and subagents started before have ended.',
}

/** The latest restart since the agent last read a message, so it knows what ended with it. */
export async function restartPreface(taskId: string): Promise<TurnPreface | null> {
  const latest = (await sessionRestarts.sinceLastTurn(taskId)).at(-1)
  return latest === undefined ? null : { text: PREFACES[latest], count: 1 }
}

/**
 * Ends the task's Claude Code process with everything running in it, and opens a new one at once
 * that resumes the conversation, or starts without it when fresh. A running turn is refused
 * unless `interrupt`, which stops it first.
 */
export async function restartSession(task: Task, input: { interrupt: boolean; fresh: boolean }): Promise<void> {
  const interrupted = isRunning(task.id)
  if (interrupted && !input.interrupt) {
    throw new HttpError(409, 'The agent is working. Stop its turn and restart, or wait until it finishes.')
  }
  if (interrupted) {
    await stopTurn(task.id)
  }
  if (input.fresh) {
    await tasks.clearSession(task.id)
  }
  await endSession(task.id)
  const kind: SessionRestart = input.fresh ? 'fresh' : 'restarted'
  await inLane(task.id, async () => {
    await appendMessage(task.id, { kind: 'seti', payload: { error: NOTES[kind], session: kind } })
    if (!sessionState(task.id).open) {
      await openWarmSession(task.id)
    }
  })
  await auditTask('task.session_restarted', task, { interrupted, fresh: input.fresh })
}
