import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { projectClaude, type MessageBody, type MessageRow, type TaskStatus } from '@seti/shared'
import { audit } from './audit.js'
import { closingLine } from './closing-line.js'
import { linkCreatedPrs } from './created-prs.js'
import { messages, tasks } from './db.js'
import { outwardToolUses } from './outward.js'
import { storedForm } from './session-start.js'
import { withTurnCost } from './store/cost.js'
import { publishFolded } from './subtask-prs.js'
import { publish } from './task-events.js'
import { trackToolCalls } from './tool-calls.js'
import { turnAsks } from './turn-asking.js'

/**
 * Called once the task stops working, with the status it ended in. A turn that a new message cut
 * short, or that Claude Code follows with a turn of its own for queued messages, does not count.
 */
type TurnEndListener = (taskId: string, status: TaskStatus) => void | Promise<void>

const turnEndListeners: TurnEndListener[] = []

/** @public */
export function onTurnEnd(listener: TurnEndListener): void {
  turnEndListeners.push(listener)
}

type SinceQuery = (taskId: string) => number | null

let sessionSince: SinceQuery = (_taskId) => null

/** Lets the session half answer when each task's open session sent its first message. */
export function answerSince(query: SinceQuery): void {
  sessionSince = query
}

export async function appendMessage(taskId: string, body: MessageBody, outward: string[] = []): Promise<MessageRow> {
  const row = await messages.insert(taskId, body, outward)
  publish(taskId, { type: 'message', row })
  await publishFolded(taskId, sessionSince(taskId))
  return row
}

async function setStatus(taskId: string, status: TaskStatus): Promise<void> {
  await tasks.setStatus(taskId, status, null)
  publish(taskId, { type: 'status', status })
}

async function record(taskId: string, m: SDKMessage): Promise<string | null> {
  const outward = outwardToolUses(m)
  trackToolCalls(taskId, projectClaude(m))
  await appendMessage(taskId, { kind: 'sdk', payload: storedForm(await withTurnCost(taskId, m)) }, outward)
  await audit.outwardCalls(taskId, m, outward)
  await audit.classifierDenial(taskId, m)
  if (outward.length > 0) {
    await tasks.addOutward(taskId, outward.length)
  }
  await linkCreatedPrs(taskId, m, sessionSince(taskId))
  if (m.type !== 'result' || !m.is_error) {
    return null
  }
  return m.subtype === 'success' ? m.result : m.subtype
}

async function reportEnd(taskId: string, status: TaskStatus, lastError: string | null): Promise<void> {
  await tasks.endTurn(taskId, {
    status,
    last_error: status === 'error' ? lastError : null,
    asking: await turnAsks(taskId, status),
    closing_line: await closingLine(taskId),
  })
  publish(taskId, { type: 'status', status })
  for (const listener of turnEndListeners) {
    await listener(taskId, status)
  }
}

/** What the session half reports as its sessions run; each call mirrors a node journal entry. */
export const journal = {
  /** Stores a message of the session; returns the error a result reports. */
  message: record,
  /** The task works: a turn started, or background work reported back. */
  turnStarted: async (taskId: string) => setStatus(taskId, 'running'),
  /** The task stopped working, with the status it ended in; the turn-end listeners follow. */
  turnEnded: reportEnd,
}
