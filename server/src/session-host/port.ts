import type { McpServerStatus, PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueueState, TaskStatus } from '@seti/shared'
import type { SessionView } from '../agent-session.js'
import type { NextMessage } from '../next-message.js'
import type { PermissionSettings } from '../permission-policy.js'
import type { SessionSpec } from '../session-spec.js'
import type { PendingRewind } from '../store/rewinds.js'
import type { UserContent } from '../user-content.js'

/** What a new process for the task starts from: its spec, the spec's key and a pending rewind. */
export interface SessionStartSpec {
  key: string | null
  spec: SessionSpec
  rewind: PendingRewind | null
}

/** A message the session wrote, with what the host measured beside it. */
interface SessionMessage {
  message: SDKMessage
  /** The context window a compaction was measured against, read from the process. */
  contextWindow?: number | null
}

/**
 * Everything the session host asks of Seti's records side and tells it. The host keeps no record
 * itself: each prompt, message, status and turn end is written by the other side.
 */
export interface ControlPort {
  /** Records the prompt and returns the text the agent gets for it, prefaces included. */
  openTurn: (taskId: string, next: NextMessage, queued: boolean) => Promise<{ content: UserContent; promptId: number }>
  /** Restores missing worktrees and reads the spec; throws when the task is gone. */
  sessionSpec: (taskId: string) => Promise<SessionStartSpec>
  taskExists: (taskId: string) => Promise<boolean>
  /** Runs what must happen before the task's process starts, such as writing its workspace. */
  opening: (taskId: string) => Promise<void>
  message: (taskId: string, message: SessionMessage) => Promise<void>
  queued: (taskId: string, promptId: number, state: Exclude<QueueState, 'waiting'>) => Promise<void>
  /** Background work reporting back started a turn. */
  working: (taskId: string) => Promise<void>
  turnEnded: (taskId: string, status: TaskStatus, error: string | null) => Promise<void>
  /** Notes an error of Seti's in the transcript. */
  note: (taskId: string, error: string) => Promise<void>
  rewound: (taskId: string, rewindId: number, refused: string | null) => Promise<void>
  /** A process opened with no message, so its MCP servers connect before the next turn. */
  warmOpened: (taskId: string) => void
  /** The session's open state or background work changed. */
  sessionChanged: (taskId: string) => void
  /** The session ended; `since` is the first prompt it sent, if any. */
  sessionEnded: (taskId: string) => void
  sessionClosed: (taskId: string, since: number | null) => Promise<void>
  /** The session's view changed, or null once it is gone. */
  view: (taskId: string, view: SessionView | null) => void
  /** Messages a session that could not start kept, with the first one's text; null once taken. */
  unstarted: (taskId: string, kept: { first: string | null } | null) => void
}

/** Whether settings changed since the open process started, as the records side reads them. */
export interface RestartCheck {
  rewind: boolean
  key: string | null
}

/** How taking a queued message back went; `taken` is the prompt id it settled, if any. */
export type QueuedCancel = 'not_queued' | 'unsupported' | 'picked_up' | { taken: number | null }

/** What Seti's records side tells the session host to do with a task's session. */
export interface SessionCommands {
  /** Sends, queues or interrupts with the message, or opens a process for it; reports it working. */
  start: (
    taskId: string,
    message: Omit<NextMessage, 'interrupted'>,
    interrupt: boolean,
    check: RestartCheck | null,
  ) => Promise<void>
  /** Opens a process for the task; reports it working when kept messages start a turn. */
  openWarm: (taskId: string) => Promise<void>
  /** Interrupts the running turn and waits until its end is reported. */
  stop: (taskId: string, deliverQueued: boolean) => Promise<void>
  /** Closes the session with everything running in it, and waits until it has ended. */
  end: (taskId: string) => Promise<void>
  /** False when a turn or background work runs, so the session stays. */
  closeIdle: (taskId: string) => Promise<boolean>
  stopTask: (taskId: string, sdkTaskId: string) => Promise<boolean>
  cancelQueued: (taskId: string, promptId: number) => Promise<QueuedCancel>
  setMode: (taskId: string, mode: PermissionMode) => Promise<'now' | 'next_turn'>
  applyPermissions: (taskId: string, permissions: PermissionSettings) => Promise<void>
  restartQuiet: (taskId: string, at?: number) => void
  /** Ends each task's turn as Seti stops; resolves once their sessions have ended. */
  cutForRestart: (taskIds: readonly string[]) => Promise<void>
  mcpStatus: (taskId: string) => Promise<McpServerStatus[] | null>
}
