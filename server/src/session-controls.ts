import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionSettings } from './permission-policy.js'
import type { QueuedCancel } from './session-host/port.js'
import { sessionHost } from './session-link.js'
import { sessionTaskIds, sessionView } from './session-mirror.js'

export { runningTurns, sessionTaskIds } from './session-mirror.js'

/** What the watchdog reads of an open session: whether a turn runs and when it last spoke. */
export interface SessionWatch {
  running: boolean
  heardAt: number
  retrying: string | null
}

/** What the watchdog needs of each session, by task id. */
export const sessionWatches = (): [string, SessionWatch][] =>
  sessionTaskIds().flatMap((taskId) => {
    const view = sessionView(taskId)
    return view === undefined
      ? []
      : [[taskId, { running: view.running, heardAt: view.heardAt, retrying: view.retrying }]]
  })

/** Starts the session's quiet clock again, as when the user answered what it waited on. */
export function restartQuiet(taskId: string, at?: number): void {
  sessionHost.restartQuiet(taskId, at)
}

/** Switches the agent's open process to the mode; 'next_turn' when it has to restart to take it. */
export const setSessionMode = async (taskId: string, mode: PermissionMode): Promise<'now' | 'next_turn'> =>
  sessionHost.setMode(taskId, mode)

/** Hands the task's running process new permission rules; it applies them to its next call. */
export const applySessionPermissions = async (taskId: string, permissions: PermissionSettings): Promise<void> =>
  sessionHost.applyPermissions(taskId, permissions)

/** Takes a message back from Claude Code's queue before the agent reads it. */
export const cancelQueuedPrompt = async (taskId: string, promptId: number): Promise<QueuedCancel> =>
  sessionHost.cancelQueued(taskId, promptId)

/** Ends each task's turn as Seti stops; resolves once their sessions have ended. */
export const cutForRestart = async (taskIds: readonly string[]): Promise<void> => sessionHost.cutForRestart(taskIds)
