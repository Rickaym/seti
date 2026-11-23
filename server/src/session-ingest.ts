import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { projectClaude, type JournalEntry, type MessageBody, type MessageRow, type TaskStatus } from '@seti/shared'
import { audit } from './audit.js'
import { closingLine } from './closing-line.js'
import { auditBlockedKey } from './connection-egress.js'
import { linkCreatedPrs } from './created-prs.js'
import { messages, tasks } from './db.js'
import { reportMemoryEvent } from './memory-scope.js'
import { serveNode } from './node-link.js'
import { outwardCalls } from './outward.js'
import type { Alongside } from './pg.js'
import { openPrompt } from './prompt-open.js'
import { markQueued } from './queued-prompts.js'
import { secretAnswers } from './secret-asks.js'
import { mirrorSession } from './session-mirror.js'
import { processStarted, recordStart, settleRewind, setupAnswers } from './session-setup.js'
import { storedForm, unstored } from './session-start.js'
import { forgetSessionTools } from './session-tools.js'
import { withTurnCost } from './store/cost.js'
import { hadRunningSubtask } from './subtask-cache.js'
import { publishFolded, publishSubtasks } from './subtask-prs.js'
import { publish } from './task-events.js'
import { forgetToolCalls, trackToolCalls } from './tool-calls.js'
import { turnAsks } from './turn-asking.js'
import { auditRefusal, turnAnswers } from './turn-asks.js'

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

/** The first prompt each task's open session sent, as its node reported it. */
const sessionSince = new Map<string, number>()

/** First message of the task's open session, which may still run subagents it started. */
export const openQuerySince = (taskId: string): number | null => sessionSince.get(taskId) ?? null

export async function appendMessage(
  taskId: string,
  body: MessageBody,
  outward: string[] = [],
  alongside?: Alongside,
): Promise<MessageRow> {
  const row = await messages.insert(taskId, body, outward, alongside)
  publish(taskId, { type: 'message', row })
  await publishFolded(taskId, openQuerySince(taskId))
  return row
}

async function setStatus(taskId: string, status: TaskStatus): Promise<void> {
  await tasks.setStatus(taskId, status, null)
  publish(taskId, { type: 'status', status })
}

async function record(taskId: string, m: SDKMessage): Promise<void> {
  const events = projectClaude(m)
  const outward = outwardCalls(events)
  trackToolCalls(taskId, events)
  await appendMessage(taskId, { kind: 'sdk', payload: storedForm(await withTurnCost(taskId, m)) }, outward)
  await audit.outwardCalls(taskId, events, outward)
  await audit.classifierDenial(taskId, events)
  if (outward.length > 0) {
    await tasks.addOutward(taskId, outward.length)
  }
  await linkCreatedPrs(taskId, events, openQuerySince(taskId))
}

/** Stores a message of the session, unless Seti does not keep it, and notes a session's start. */
async function storeMessage(taskId: string, m: SDKMessage): Promise<void> {
  if (await unstored(taskId, m)) {
    return
  }
  await record(taskId, m)
  await recordStart(taskId, m)
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

/** Forgets the ended session, and shows its subtasks again if one was still running. */
async function sessionClosed(taskId: string, since: number | null): Promise<void> {
  sessionSince.delete(taskId)
  forgetToolCalls(taskId)
  forgetSessionTools(taskId)
  if (since !== null && (await hadRunningSubtask(taskId, since))) {
    await publishSubtasks(taskId, openQuerySince(taskId))
  }
}

type EntryOf<T extends JournalEntry['type']> = Extract<JournalEntry, { type: T }>
type Ingest = { [T in JournalEntry['type']]: (taskId: string, entry: EntryOf<T>) => unknown }

/** What the control plane does with each entry a node reports. */
const ingest: Ingest = {
  // The runtime adapter of the session wrote the payload.
  message: async (taskId, { payload }) => storeMessage(taskId, payload as SDKMessage),
  'turn.started': async (taskId) => setStatus(taskId, 'running'),
  'turn.ended': async (taskId, { status, error }) => reportEnd(taskId, status, error),
  note: async (taskId, { error }) => appendMessage(taskId, { kind: 'seti', payload: { error } }),
  'queued.settled': async (taskId, { promptId, state }) => markQueued(taskId, promptId, state),
  'session.opened': (taskId) => sessionSince.delete(taskId),
  'session.started': (taskId, { warm }) => {
    processStarted(taskId, warm)
  },
  'guard.refused': async (taskId, { command, reason }) => auditRefusal(taskId, command, reason),
  'egress.blocked': async (taskId, { host, names }) => auditBlockedKey(taskId, host, names),
  'memory.event': (taskId, { report }) => {
    reportMemoryEvent(taskId, report)
  },
  'rewind.settled': async (_taskId, { id, state, reason }) => settleRewind(id, state, reason),
  'session.since': (taskId, { promptId }) => sessionSince.set(taskId, promptId),
  'session.closed': async (taskId, { since }) => sessionClosed(taskId, since),
  'session.state': (taskId, { open, background }) => {
    publish(taskId, { type: 'session', session: { open, background } })
  },
  'session.changed': (taskId, state) => {
    mirrorSession(taskId, state)
  },
}

async function journal<T extends JournalEntry['type']>(taskId: string, entry: EntryOf<T>): Promise<void> {
  const take = ingest[entry.type] as (taskId: string, entry: EntryOf<T>) => unknown
  await take(taskId, entry)
}

serveNode({
  journal,
  answer: {
    'prompt.open': async (taskId, ask) => openPrompt(taskId, ask, appendMessage),
    ...setupAnswers,
    ...turnAnswers,
    ...secretAnswers,
  },
})
