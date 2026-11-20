import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageBody, MessageRow, TaskStatus } from '@seti/shared'
import { audit } from './audit.js'
import { closingLine } from './closing-line.js'
import { withContextWindow } from './compact.js'
import { linkCreatedPrs } from './created-prs.js'
import { messages, tasks } from './db.js'
import { watchSessionMcp } from './mcp-session-status.js'
import { outwardToolUses } from './outward.js'
import { markQueued } from './queued-prompts.js'
import { sessionOpening } from './session-hooks.js'
import type { ControlPort, SessionCommands } from './session-host/port.js'
import { openQuerySince, sessionMirror, sessionState } from './session-mirror.js'
import { sessionSpec } from './session-spec.js'
import { recordSessionStart, storedForm, unstored } from './session-start.js'
import { withTurnCost } from './store/cost.js'
import { rewinds } from './store/rewinds.js'
import { hadRunningSubtask } from './subtask-cache.js'
import { publishFolded, publishSubtasks } from './subtask-prs.js'
import { publish } from './task-events.js'
import { forgetToolCalls, trackToolCalls } from './tool-calls.js'
import { turnAsks } from './turn-asking.js'
import { promptFor } from './turn-prompt.js'
import { userContent } from './user-content.js'
import { restoreMissingWorktrees } from './worktree-restore.js'

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

function publishSession(taskId: string): void {
  publish(taskId, { type: 'session', session: sessionState(taskId) })
}

export async function appendMessage(taskId: string, body: MessageBody, outward: string[] = []): Promise<MessageRow> {
  const row = await messages.insert(taskId, body, outward)
  publish(taskId, { type: 'message', row })
  await publishFolded(taskId, openQuerySince(taskId))
  return row
}

export async function setStatus(taskId: string, status: TaskStatus): Promise<void> {
  await tasks.setStatus(taskId, status, null)
  publish(taskId, { type: 'status', status })
}

async function record(taskId: string, m: SDKMessage): Promise<void> {
  const outward = outwardToolUses(m)
  trackToolCalls(taskId, m)
  await appendMessage(taskId, { kind: 'sdk', payload: storedForm(await withTurnCost(taskId, m)) }, outward)
  await audit.outwardCalls(taskId, m, outward)
  await audit.classifierDenial(taskId, m)
  if (outward.length > 0) {
    await tasks.addOutward(taskId, outward.length)
  }
  await linkCreatedPrs(taskId, m, openQuerySince(taskId))
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

const note = async (taskId: string, error: string) => {
  await appendMessage(taskId, { kind: 'seti', payload: { error } })
}

/** Restores the task's missing worktrees and reads what its next process starts from. */
async function startSpec(taskId: string) {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new Error('Task was deleted before its session started')
  }
  await restoreMissingWorktrees(task, async (error) => note(taskId, error))
  const { key, spec } = await sessionSpec(task)
  return { key, spec, rewind: (await rewinds.pending(taskId)) ?? null }
}

/** Seti's records side of the session host: every record a session makes is written here. */
export function createControlPort(commands: () => SessionCommands): ControlPort {
  const mcpStatus = (taskId: string) => async () => commands().mcpStatus(taskId)
  return {
    openTurn: async (taskId, next, queued) => {
      const { payload, text } = await promptFor(taskId, next, queued)
      const content = userContent(taskId, text, next.attachments ?? [])
      return { content, promptId: (await appendMessage(taskId, { kind: 'prompt', payload })).id }
    },
    sessionSpec: startSpec,
    taskExists: async (taskId) => (await tasks.get(taskId)) !== undefined,
    opening: sessionOpening,
    message: async (taskId, { message, contextWindow }) => {
      if (await unstored(taskId, message)) {
        return
      }
      await record(taskId, await withContextWindow(message, async () => Promise.resolve(contextWindow ?? null)))
      await recordSessionStart(taskId, message, mcpStatus(taskId))
    },
    queued: markQueued,
    working: async (taskId) => setStatus(taskId, 'running'),
    turnEnded: reportEnd,
    note,
    rewound: async (_taskId, rewindId, refused) => {
      await (refused === null ? rewinds.settle(rewindId, 'applied') : rewinds.settle(rewindId, 'refused', refused))
    },
    warmOpened: (taskId) => {
      void watchSessionMcp(taskId, mcpStatus(taskId))
    },
    sessionChanged: publishSession,
    sessionEnded: forgetToolCalls,
    sessionClosed: async (taskId, since) => {
      publishSession(taskId)
      if (since !== null && (await hadRunningSubtask(taskId, since))) {
        await publishSubtasks(taskId, openQuerySince(taskId))
      }
    },
    view: sessionMirror.view,
    unstarted: sessionMirror.unstarted,
  }
}
