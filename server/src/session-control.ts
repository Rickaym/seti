import type { PromptAttachment } from '@seti/shared'
import type { SendOutcome } from './agent-session.js'
import { refuseArchived } from './archive-guard.js'
import { tasks } from './db.js'
import { HttpError } from './http.js'
import type { NextMessage } from './next-message.js'
import { controlLink } from './node-link.js'
import { checkSend } from './send-check.js'
import { isRunning } from './session-mirror.js'
import { inLane } from './task-lane.js'

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

/**
 * Checks a message against the task and its running turn, then hands it to the agent's node,
 * which starts a turn, queues it or cuts the running turn short.
 */
async function sendTurn(
  taskId: string,
  message: Omit<NextMessage, 'interrupted'>,
  interrupt: boolean,
): Promise<{ count: number; outcome: SendOutcome }> {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new HttpError(404, 'Task not found')
  }
  refuseArchived(task)
  const count = await checkSend(taskId, message, isRunning(taskId))
  const { outcome } = await controlLink.command('turn.send', { agent: taskId, message, interrupt })
  return { count, outcome }
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
  return (await inLane(taskId, async () => sendTurn(taskId, message, options.interrupt === true))).outcome
}

/**
 * Hands the agent the pending prefaces with no user text, in a new turn or queued for a turn of
 * their own after the running one, or sooner with a priority; returns their count. With `held`,
 * the updates that wait for the user's next message go too.
 */
export async function runAutoTurn(taskId: string, how: Pick<NextMessage, 'priority' | 'held'> = {}): Promise<number> {
  return (await inLane(taskId, async () => sendTurn(taskId, { prompt: null, ...how }, false))).count
}

/** Interrupts the running turn and waits; queued messages go back, or on with `deliverQueued`. */
export async function stopTurn(taskId: string, { deliverQueued = false } = {}): Promise<void> {
  const notRunning = new HttpError(409, 'Task is not running')
  if (!isRunning(taskId)) {
    throw notRunning
  }
  const { stopped } = await controlLink.command('turn.stop', { agent: taskId, deliverQueued })
  if (!stopped) {
    throw notRunning
  }
}

/**
 * Opens a process for a task without an open one. It sends the messages a session that could not
 * start kept; with none, it waits for the next turn.
 */
export async function openWarmSession(taskId: string): Promise<void> {
  await controlLink.command('session.open', { agent: taskId })
}

/** Closes the task's session with everything running in it, and waits until it has ended. */
export async function endSession(taskId: string): Promise<void> {
  await controlLink.command('session.close', { agent: taskId, onlyIdle: false })
}

/** Closes the task's session if nothing runs in it; false when a turn or background work runs. */
export async function closeIdleSession(taskId: string): Promise<boolean> {
  return (await controlLink.command('session.close', { agent: taskId, onlyIdle: true })).closed
}

/** Asks the task's open session to stop one of its subagents or background commands. */
export async function stopSessionTask(taskId: string, sdkTaskId: string): Promise<boolean> {
  return (await controlLink.command('background.stop', { agent: taskId, task: sdkTaskId })).stopped
}
