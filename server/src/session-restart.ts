import type { StoredRuntime, Task } from '@seti/shared'
import { auditTask } from './audit.js'
import { tasks } from './db.js'
import { refuseOnSelf } from './ea-guard.js'
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

const ENDED =
  'The conversation continues, but background shells, processes and subagents ' +
  'you started before the restart have ended; start again any you still need.'

const PREFACE: Record<StoredRuntime, string> = {
  claude: `The user restarted your Claude Code session from Seti, so your tools, MCP servers and plugins were loaded again. ${ENDED}`,
  codex: `The user restarted your Codex session from Seti, so your tools and Seti's tools were loaded again. ${ENDED}`,
}

/** The latest restart since the agent last read a message, so it knows what ended with it. */
export async function restartPreface(taskId: string): Promise<TurnPreface | null> {
  if (!(await sessionRestarts.sinceLastTurn(taskId))) {
    return null
  }
  return { text: PREFACE[(await tasks.get(taskId))?.runtime ?? 'claude'], count: 1 }
}

/**
 * Ends the task's Claude Code process with everything running in it, and opens a new one at once
 * that resumes the conversation. A running turn is refused unless `interrupt`, which stops it
 * first.
 */
export async function restartSession(task: Task, input: { interrupt: boolean }): Promise<void> {
  refuseOnSelf(task.id, 'restart')
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
