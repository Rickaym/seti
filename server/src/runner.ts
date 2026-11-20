import type { PromptAttachment, Task } from '@seti/shared'
import { outcomeOf, type SendOutcome, type SessionView } from './agent-session.js'
import { refuseArchived } from './archive-guard.js'
import { tasks } from './db.js'
import { HttpError } from './http.js'
import type { NextMessage } from './next-message.js'
import { checkSend } from './send-check.js'
import type { RestartCheck } from './session-host/port.js'
import { setStatus } from './session-ingest.js'
import { sessionHost } from './session-link.js'
import { isRunning, sessionView } from './session-mirror.js'
import { setupKey } from './session-spec.js'
import { rewinds } from './store/rewinds.js'
import { inLane } from './task-lane.js'

export { registerSessionMcpServers } from './session-decisions.js'
export { appendMessage, onTurnEnd } from './session-ingest.js'
export { autoQueueBlocker, isRunning, openQuerySince, sessionState } from './session-mirror.js'
export { agentEnv } from './session-realise.js'
export { registerContextProvider } from './session-spec.js'
export { publish, subscribe } from './task-events.js'
export { registerTurnPreface, type TurnPreface } from './turn-prompt.js'

interface TurnOptions {
  /** Cut a running turn short instead of queueing the message for it. */
  interrupt?: boolean
  attachments?: PromptAttachment[]
  /** Sends the user's last message again, which only an idle agent takes. */
  retry?: boolean
  /** The browser's id for the send, kept on the prompt row so the browser can match it. */
  clientId?: string
  /** Who wrote the message when not the user. */
  from?: string | undefined
}

/** Sends the user's prompt and its files to the task's agent, after what the turn prefaces report. */
export async function runTurn(taskId: string, prompt: string, options: TurnOptions = {}): Promise<SendOutcome> {
  const message = {
    prompt,
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.retry === true ? { retry: true } : {}),
    ...(options.clientId === undefined ? {} : { client_id: options.clientId }),
    ...(options.from === undefined ? {} : { from: options.from }),
  }
  return (await inLane(taskId, async () => startTurn(taskId, message, options.interrupt === true))).outcome
}

/**
 * Hands the agent the pending prefaces with no user text, in a new turn or queued for a turn of
 * their own after the running one, or sooner with a priority; returns their count. With `held`,
 * the updates that wait for the user's next message go too.
 */
export async function runAutoTurn(taskId: string, how: Pick<NextMessage, 'priority' | 'held'> = {}): Promise<number> {
  return (await inLane(taskId, async () => startTurn(taskId, { prompt: null, ...how }, false))).count
}

/**
 * What the open, idle session would need a new process for: a pending rewind or changed
 * settings. Null when no such session is open, or background work runs in it.
 */
async function restartCheck(task: Task, view: SessionView | undefined): Promise<RestartCheck | null> {
  if (view?.open !== true || view.running || view.background > 0) {
    return null
  }
  const rewind = (await rewinds.pending(task.id)) !== undefined
  return { rewind, key: rewind ? null : await setupKey(task) }
}

/**
 * Checks a message and hands it to the task's session, which queues it for a running turn or
 * cuts that short when asked, and holds it while the session starts or a turn is being cut short.
 */
async function startTurn(
  taskId: string,
  message: Omit<NextMessage, 'interrupted'>,
  interrupt: boolean,
): Promise<{ count: number; outcome: SendOutcome }> {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new HttpError(404, 'Task not found')
  }
  refuseArchived(task)
  const view = sessionView(taskId)
  const running = view?.running === true
  const count = await checkSend(taskId, message, running)
  await sessionHost.start(taskId, message, interrupt, await restartCheck(task, view))
  await setStatus(taskId, 'running')
  return { count, outcome: outcomeOf(running, interrupt) }
}

/** Interrupts the running turn and waits; queued messages go back, or on with `deliverQueued`. */
export async function stopTurn(taskId: string, { deliverQueued = false } = {}): Promise<void> {
  if (!isRunning(taskId)) {
    throw new HttpError(409, 'Task is not running')
  }
  await sessionHost.stop(taskId, deliverQueued)
}

/**
 * Opens a process for a task without an open one. It sends the messages a session that could not
 * start kept; with none, it waits for the next turn.
 */
export async function openWarmSession(taskId: string): Promise<void> {
  sessionHost.openWarm(taskId)
  if (isRunning(taskId)) {
    await setStatus(taskId, 'running')
  }
}

/** Asks the task's open session to stop one of its subagents or background commands. */
export const stopSessionTask = async (taskId: string, sdkTaskId: string): Promise<boolean> =>
  sessionHost.stopTask(taskId, sdkTaskId)

/** Closes the task's session with everything running in it, and waits until it has ended. */
export const endSession = async (taskId: string): Promise<void> => sessionHost.end(taskId)

/** Closes the task's session if nothing runs in it; false when a turn or background work runs. */
export const closeIdleSession = async (taskId: string): Promise<boolean> => sessionHost.closeIdle(taskId)
