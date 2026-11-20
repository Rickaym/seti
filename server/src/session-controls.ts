import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionSettings } from './permission-policy.js'
import { liveSessions } from './runner.js'
import type { CutTurn } from './store/restart.js'

/** What the watchdog reads of an open session: whether a turn runs and when it last spoke. */
export interface SessionWatch {
  running: boolean
  heardAt: number
  retrying: string | null
}

const sessionOf = (taskId: string) => liveSessions().find(([id]) => id === taskId)?.[1]

/** Ids of the tasks with a session, open or closing. */
export const sessionTaskIds = (): string[] => liveSessions().map(([taskId]) => taskId)

/** What the watchdog needs of each session, by task id. */
export const sessionWatches = (): [string, SessionWatch][] =>
  liveSessions().map(([taskId, { running, heardAt, retrying }]) => [taskId, { running, heardAt, retrying }])

/** Starts the session's quiet clock again, as when the user answered what it waited on. */
export function restartQuiet(taskId: string, at?: number): void {
  sessionOf(taskId)?.restartQuiet(at)
}

/** Switches the agent's open process to the mode; 'next_turn' when it has to restart to take it. */
export async function setSessionMode(taskId: string, mode: PermissionMode): Promise<'now' | 'next_turn'> {
  const session = sessionOf(taskId)
  if (session === undefined || session.closed) {
    return 'now'
  }
  const query = session.openQuery
  if (query === null) {
    return 'next_turn'
  }
  return query.setPermissionMode(mode).then(
    () => 'now',
    () => 'next_turn',
  )
}

/** Hands the task's running process new permission rules; it applies them to its next call. */
export async function applySessionPermissions(taskId: string, permissions: PermissionSettings): Promise<void> {
  await sessionOf(taskId)?.applyPermissions(permissions)
}

/** How taking a queued message back went; `taken` is the prompt id it settled, if any. */
export type QueuedCancel = 'not_queued' | 'unsupported' | 'picked_up' | { taken: number | null }

/** Takes a message back from Claude Code's queue before the agent reads it. */
export async function cancelQueuedPrompt(taskId: string, promptId: number): Promise<QueuedCancel> {
  const session = sessionOf(taskId)
  const uuid = session?.uuidOf(promptId) ?? null
  if (session === undefined || uuid === null) {
    return 'not_queued'
  }
  const cancelled = await session.cancelQueued(uuid)
  if (cancelled === null) {
    return 'unsupported'
  }
  return cancelled ? { taken: session.settle(uuid) } : 'picked_up'
}

/** The turns running now: what started each and how much background work runs with it. */
export const runningTurns = (): CutTurn[] =>
  liveSessions()
    .filter(([, session]) => session.running && !session.closed)
    .map(([taskId, session]) => ({ task_id: taskId, kind: session.turnKind, background: session.backgroundCount }))

/** Ends each task's turn as Seti stops; resolves once their sessions have ended. */
export async function cutForRestart(taskIds: readonly string[]): Promise<void> {
  const cut = liveSessions().filter(([taskId]) => taskIds.includes(taskId))
  for (const [, session] of cut) {
    session.cutForRestart()
  }
  await Promise.allSettled(cut.map(async ([, session]) => session.done))
}
