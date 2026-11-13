import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { accessChoices } from './access.js'
import { agentColorInput, storedAgentColor, type AgentColor } from './agent-color.js'
import type { TaskSetup } from './agent-start.js'
import { attachmentRefs, type AttachmentRef, type PromptAttachment } from './attachments.js'
import { clientSendId } from './client-send.js'
import { DEFAULT_PROFILE_ID } from './credentials.js'
import type { EaNotice } from './ea.js'
import { INPUT_MODES, type InputMode, type TaskInput } from './inputs.js'
import { lenientArray, opaque, orDefault, type ResponseSchema } from './lenient.js'
import { mcpChoiceFields } from './mcp.js'
import type { MemoryEvent } from './memory.js'
import type { ModelFallback } from './model-fallback.js'
import type { PermissionRequest } from './permissions.js'
import { disabledPluginIds } from './plugins.js'
import { prUrl } from './pr-url.js'
import { checkRepoSelection, repoSelectionFields, withRepoIds, type RepoRef } from './repos.js'
import { DEFAULT_SETI_CONTROL, setiControlLevel, type SetiControlLevel } from './seti-control.js'
import type { ShellProgress, ShellResult } from './shell.js'
import type { SubtaskBrief } from './subtasks.js'
import type { AgentTodo } from './todos.js'
import type { WarmCacheSeed } from './warm-caches.js'
import { workspaceId } from './workspaces.js'

export const TASK_STATUSES = ['idle', 'running', 'error', 'stopped', 'interrupted'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Where a linked PR stands on GitHub; a draft is still open. */
export type LinkedPrState = 'open' | 'merged' | 'closed'

/**
 * A task's status as shown: a task with a subagent still running shows running, an idle task
 * whose PRs all landed shows complete, one whose turn ended on a question shows asking, and one
 * whose work cannot go on without the user, such as a call waiting for permission, shows blocked.
 */
export type TaskDisplayStatus = TaskStatus | 'complete' | 'asking' | 'blocked'

/** Turns that failed: one that errored, or one a Seti restart cut off. */
const FAILED_STATUSES: readonly TaskDisplayStatus[] = ['error', 'interrupted']

/** Agents that wait on the user: a turn that failed, ended by asking the user, or is blocked. */
export const NEEDS_YOU_STATUSES: readonly TaskDisplayStatus[] = [...FAILED_STATUSES, 'asking', 'blocked']

export const needsYou = (status: TaskDisplayStatus) => NEEDS_YOU_STATUSES.includes(status)

/**
 * In the Needs you group: a needs-you status the user has not opened the agent to see yet, or a
 * blocked agent, which stays there until the user answers it.
 */
export const waitsOnYou = (task: Pick<Task, 'unseen'>, status: TaskDisplayStatus) =>
  status === 'blocked' || (task.unseen && needsYou(status))

export const failed = (status: TaskDisplayStatus) => FAILED_STATUSES.includes(status)

export const runningSubtasks = (subtasks: readonly Pick<SubtaskBrief, 'status'>[]) =>
  subtasks.filter((subtask) => subtask.status === 'running').length

/** What a task's PRs say about whether its work landed. */
export interface PrStates {
  /** Last polled state per PR URL, covering at least the PRs linked to it and its subagents. */
  by_url: Record<string, LinkedPrState>
  /** Whether any of its PRs merged, counting the PRs Seti unlinked once they merged or closed. */
  any_merged: boolean
}

/** Every polled state of a task's PRs; `keep` narrows `by_url` but not `any_merged`. */
export function prStates(all: Readonly<Record<string, LinkedPrState>>, keep?: ReadonlySet<string>): PrStates {
  const entries = Object.entries(all)
  return {
    by_url: Object.fromEntries(keep === undefined ? entries : entries.filter(([url]) => keep.has(url))),
    any_merged: entries.some(([, state]) => state === 'merged'),
  }
}

/** Idle, no linked PR still open and one of its PRs merged; an unpolled PR counts as open. */
export function isComplete(task: Pick<Task, 'status' | 'pr_urls'>, prs: PrStates): boolean {
  return (
    task.status === 'idle' &&
    prs.any_merged &&
    task.pr_urls.every((url) => prs.by_url[url] === 'merged' || prs.by_url[url] === 'closed')
  )
}

/** `running` is how many of its subagents run now. */
export function displayStatus(
  task: Pick<Task, 'status' | 'pr_urls' | 'asking'> & Partial<Pick<Task, 'blocked'>>,
  prs: PrStates,
  running: number,
): TaskDisplayStatus {
  if ((task.blocked ?? null) !== null) {
    return 'blocked'
  }
  if (running > 0) {
    return 'running'
  }
  if (isComplete(task, prs)) {
    return 'complete'
  }
  return task.status === 'idle' && task.asking ? 'asking' : task.status
}

const MAX_TASK_PRS = 50

/** The longest live status an agent shows on its row. */
export const STATUS_LINE_MAX = 60

/** A short live status an agent sets on its own row, such as waiting on CI; empty clears it. */
export const statusLineText = z.string().trim().max(STATUS_LINE_MAX)

export const createTaskInput = z
  .object({
    /** Left out, Seti's planner titles the agent from the prompt. */
    title: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1, 'prompt is required'),
    ...repoSelectionFields,
    cwd: z.string().trim().optional(),
    worktree: z.boolean().default(false),
    ref: z.string().trim().min(1).optional(),
    pr_urls: z.array(prUrl).max(MAX_TASK_PRS).optional(),
    /** Leave out for the packs linked by default. */
    context_pack_ids: z.array(z.uuid()).optional(),
    disabled_plugin_ids: disabledPluginIds,
    /** MCP servers this agent turns on or off against the defaults. */
    ...mcpChoiceFields,
    /** Run in Claude Code's sandbox when the sandbox setting is on; off for ssh or cloud CLIs. */
    sandbox: z.boolean().default(true),
    /** Overrides against the access defaults, such as ssh hosts or AWS; see effective access. */
    access: accessChoices,
    /** The credential profile whose tokens the sandbox proxy adds. */
    profile_id: z.string().trim().min(1).max(64).default(DEFAULT_PROFILE_ID),
    /** How far the agent's seti MCP tools reach; a security setting. */
    seti_control: setiControlLevel.default(DEFAULT_SETI_CONTROL),
    /** Left out, the agent joins the first workspace. */
    workspace_id: workspaceId.optional(),
  })
  .superRefine(checkRepoSelection)
  .transform(withRepoIds)
export type CreateTaskInput = z.input<typeof createTaskInput>
export type CreateTaskRequest = z.output<typeof createTaskInput>
/** A create request with its title settled, and how the planner set it up when it did. */
export type TaskRequest = CreateTaskRequest & { title: string; setup?: TaskSetup; attachments?: AttachmentRef[] }

export const updateTaskInput = z.object({
  title: z.string().trim().min(1).optional(),
  /** One of the task's repo or directory paths; its session restarts there at the next turn. */
  cwd: z.string().trim().min(1).optional(),
  input_mode: z.enum(INPUT_MODES).optional(),
  sandbox: z.boolean().optional(),
  pinned: z.boolean().optional(),
  profile_id: z.string().trim().min(1).max(64).optional(),
  seti_control: setiControlLevel.optional(),
  /** A preset name or a hex; null clears it. */
  color: agentColorInput.nullable().optional(),
  /** Moves the agent to this workspace; archived agents can move too. */
  workspace_id: workspaceId.optional(),
  /** Keeps the agent's turns from notifying any device. */
  notifications_muted: z.boolean().optional(),
})

export const taskPrInput = z.object({ url: prUrl })

/** Adds a registered repo to a task: its checkout, or a new worktree like at creation. */
export const taskRepoInput = z.object({
  repo_id: z.uuid(),
  worktree: z.boolean().default(false),
  ref: z.string().trim().min(1).optional(),
})
export type TaskRepoInput = z.input<typeof taskRepoInput>

export const taskRepoParams = z.object({ id: z.string().min(1), repo_id: z.string().min(1) })

/** An existing directory, absolute or under ~/, the agent can read and edit besides its own. */
export const taskDirInput = z.object({ path: z.string().trim().min(1, 'path is required') })
export type TaskDirInput = z.input<typeof taskDirInput>

export const sendMessageInput = z.object({
  prompt: z.string().trim().min(1, 'prompt is required'),
  /** Cut a running turn short and send this instead of queueing it; an idle task starts normally. */
  interrupt: z.boolean().default(false),
  attachments: attachmentRefs,
  /** Tells the agent or EA that sends it when the turn that takes it ends, as an update. */
  notify_when_done: z.boolean().default(false),
  client_id: clientSendId,
})
export type SendMessageInput = z.input<typeof sendMessageInput>

/** Ends the agent's Claude Code process and starts a new one at once. */
export const restartSessionInput = z.object({
  /** Stop a running turn first; without it a running agent is refused. */
  interrupt: z.boolean().default(false),
  /** Start a new session that has none of the conversation, instead of resuming it. */
  fresh: z.boolean().default(false),
})
export type RestartSessionInput = z.input<typeof restartSessionInput>

/** What a stop does with queued messages: takes them back, or hands written ones to the agent. */
export const stopTurnQuery = z.object({ queued: z.enum(['remove', 'deliver']).default('remove') })

const TRANSCRIPT_TAIL = 150
const TRANSCRIPT_PAGE = 100

/** A task stream position: newest message id held, then the server run and its last event seen. */
export const TASK_STREAM_CURSOR = /^(\d+)(?:\.([0-9a-f]+)\.(\d+))?$/

export const taskStreamQuery = z.object({
  after: z.string().regex(TASK_STREAM_CURSOR).optional(),
  tail: z.coerce.number().int().min(1).max(1000).default(TRANSCRIPT_TAIL),
})

/** The most rows one transcript page request loads. */
export const TRANSCRIPT_PAGE_MAX = 500

export const messagePageQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(TRANSCRIPT_PAGE_MAX).default(TRANSCRIPT_PAGE),
})

/** The page before `before` (or the newest), the page after `after`, or a window around `around`. */
export const taskMessagesQuery = messagePageQuery
  .extend({
    after: z.coerce.number().int().min(0).optional(),
    around: z.coerce.number().int().positive().optional(),
  })
  .refine((q) => [q.before, q.after, q.around].filter((value) => value !== undefined).length <= 1, {
    message: 'Pass at most one of before, after and around',
  })

/** Looks for the user's own message just before `before` or just after `after`. */
export const ownMessageQuery = z
  .object({
    before: z.coerce.number().int().positive().optional(),
    after: z.coerce.number().int().min(0).optional(),
  })
  .refine((q) => (q.before === undefined) !== (q.after === undefined), {
    message: 'Pass one of before and after',
  })

/** The user's nearest own message past a loaded edge of the transcript, and how to load it. */
export interface OwnMessageStep {
  /** Its id, or null when the user wrote no message in that direction. */
  id: number | null
  /** The page limit that loads every row from the edge to it, or null when one page cannot. */
  reach: number | null
}

export const taskMessageParams = z.object({
  id: z.string().min(1),
  message_id: z.coerce.number().int().positive(),
})

/** A repo of a task and the directory the agent sees it at. */
export interface TaskRepo extends RepoRef {
  dir: string
  /** The directory is a worktree Seti created for this task. */
  worktree: boolean
}

export interface Task {
  id: string
  title: string
  /** The repo the agent runs in, also the first entry of repos. */
  repo_id: string | null
  repo_slug: string | null
  repos: TaskRepo[]
  /** Plain directories the agent can edit besides its working directory and repos. */
  dirs: string[]
  cwd: string
  /** Some repo of the task is a worktree Seti created for it. */
  worktree: boolean
  /** Asked to run sandboxed; it does while the sandbox setting is on too. */
  sandbox: boolean
  /** The credential profile a sandboxed task's proxy takes GitHub, AWS and header credentials from. */
  profile_id: string
  /** How far the agent's seti MCP tools reach: nothing, the agent itself, or Seti as the EA. */
  seti_control: SetiControlLevel
  /** Until when the agent runs every tool without asking; null while Bypass is off. */
  bypass_until: string | null
  /** Linked pull requests, oldest link first. */
  pr_urls: string[]
  /** What happens when a linked PR or another outside source sends an update. */
  input_mode: InputMode
  session_id: string | null
  /** The terminal session this task was imported from; Seti resumes its own fork of it. */
  source_session_id: string | null
  status: TaskStatus
  permission_mode: string | null
  model: string | null
  /** The fallback model Claude Code moved the session to after a refusal; null while on its own. */
  model_fallback: ModelFallback | null
  cost_usd: number
  outward_count: number
  last_error: string | null
  created_at: string
  updated_at: string
  /** Set while the agent is archived: its transcript is compressed and it takes no work. */
  archived_at: string | null
  /** A long-running agent: listed first and never archived or cleaned up on its own. */
  pinned: boolean
  /** Marks the agent's row, header and mentions; null for none. */
  color: AgentColor | null
  /** What the planner chose when the agent started from a message; null otherwise. */
  setup: TaskSetup | null
  /** Build caches copied into its worktrees when Seti made them. */
  warm_caches: WarmCacheSeed[]
  /** The workspace the agent belongs to. */
  workspace_id: string
  /** Its turn ends and needs-you states notify no device. */
  notifications_muted: boolean
  /** A short live status the agent set during its turn, such as waiting on CI; null for none. */
  status_line: string | null
  /** When the agent set its status line; null without one. */
  status_line_at: string | null
  /** Its last turn ended and the user has not looked at the agent since; false while it runs. */
  unseen: boolean
  /** Its last turn ended by asking the user something; false once another turn starts. */
  asking: boolean
  /** The first line of what its last turn ended with, secrets redacted; null while it runs. */
  closing_line: string | null
  /** Why its work cannot go on without the user, such as a tool call to allow; null otherwise. */
  blocked: string | null
}

/**
 * Where a message sent during a turn is: waiting in Claude Code's queue, read by the agent, or
 * taken back before the agent read it.
 */
export type QueueState = 'waiting' | 'delivered' | 'removed'

/** A turn's prompt; `auto` turns carry no user text and start because updates arrived. */
export interface PromptPayload {
  text: string
  auto?: boolean
  /** Updates from outside the conversation the agent received with this turn. */
  inputs?: number
  /** This message stopped the turn that was running when it was sent. */
  interrupted?: boolean
  /** Sent while a turn ran, so Claude Code queued it for the next point the agent can read it. */
  queued?: QueueState
  /** The user's last message sent again by Retry turn; the transcript shows the original. */
  retry?: boolean
  /** Files sent with it, which `text` points the agent to. */
  attachments?: PromptAttachment[]
  /** The browser's id for the send that wrote it, so the browser can replace its pending copy. */
  client_id?: string
  /** Who wrote a new agent's first message when it was not the user: the EA, or an agent. */
  from?: string
}

interface MessageBase {
  id: number
  task_id: string
  outward: string[]
  created_at: string
  /** Tool use ids, or shell streams, this copy cuts; only copies sent to the browser carry it. */
  trimmed?: string[]
}

export type MessageBody =
  | { kind: 'prompt'; payload: PromptPayload }
  | { kind: 'sdk'; payload: SDKMessage }
  /**
   * A note from Seti; `stopped` marks one about a process the user stopped, `session` one about a
   * session restart and `seti_control` one about the agent's Seti control level, which the agent
   * reads; `memory` one about the agent's memory cap, with `ended_turn` when the cap stopped Claude
   * Code itself; `bypass` one about Bypass turning on or off.
   */
  | {
      kind: 'seti'
      payload: {
        error: string
        stopped?: boolean
        session?: SessionRestart
        /** A level; notes written before levels existed hold true for on and false for off. */
        seti_control?: SetiControlLevel | boolean
        /** The level before this change, so a change undone before the next turn says nothing. */
        seti_control_was?: SetiControlLevel
        bypass?: boolean
        memory?: MemoryEvent
        ended_turn?: boolean
      }
    }
  | { kind: 'shell'; payload: ShellResult }
  | { kind: 'input'; payload: TaskInput }
  /** An EA inbox item in the EA chat; task transcripts never hold one. */
  | { kind: 'notice'; payload: EaNotice }

/** A stored message Seti cannot read: its stored kind and why, never its content. */
export interface UnreadablePayload {
  kind: string
  reason: string
}

/** A body read back from the transcript; one that does not fit its kind reads as unreadable. */
export type StoredBody = MessageBody | { kind: 'unreadable'; payload: UnreadablePayload }

export type MessageRow = MessageBase & StoredBody

export interface MessagePage {
  messages: MessageRow[]
  has_older: boolean
  /** Set on pages read with `after` or `around`: later messages exist past the last one. */
  has_newer?: boolean
}

/** The task's Claude Code process, kept open between turns while it has work or might get more. */
export interface TaskSession {
  open: boolean
  /** Background subagents and commands still running in it. */
  background: number
}

/** Every directory the agent works in besides its working directory, repos first. */
export const extraDirs = (task: Pick<Task, 'cwd' | 'repos' | 'dirs'>): string[] => [
  ...new Set([...task.repos.map((repo) => repo.dir), ...task.dirs].filter((dir) => dir !== task.cwd)),
]

/** Seti's note when it sent a message again that Claude Code closed a turn without reading. */
export const RESENT_NOTE =
  'Claude Code closed the turn without reading this message (it was cleaning up a background shell ' +
  'of the previous session), so Seti sent it again.'

/** How the user restarted a task's session: resuming the conversation, or fresh without it. */
export type SessionRestart = 'restarted' | 'fresh'

export type TaskEvent =
  | { type: 'message'; row: MessageRow }
  /** A message the stream sent before changed, such as a queued prompt the agent picked up. */
  | { type: 'updated'; row: MessageRow }
  | { type: 'status'; status: TaskStatus }
  | { type: 'session'; session: TaskSession }
  /** The task's session reported how its MCP servers connect. */
  | { type: 'mcp' }
  | { type: 'shell'; progress: ShellProgress }
  | { type: 'prs' }
  | { type: 'subtasks'; subtasks: SubtaskBrief[] }
  /** The agent's todo list changed. */
  | { type: 'todos'; todos: AgentTodo[] }
  | { type: 'archived'; archived: boolean }
  /** A permission request was made, answered or dropped; `blocked` is the task's reason now. */
  | { type: 'permission'; request: PermissionRequest; blocked: string | null }
  /** Why the agent waits on the user changed; null once nothing holds it up. */
  | { type: 'blocked'; blocked: string | null }
  /** Blocks a mod draws in the task's transcript changed, such as a new aside. */
  | { type: 'blocks'; mod: string }
  /** The session moved to a fallback model or off it. */
  | { type: 'model' }

/** Shown in place of a status a newer server sends that this UI does not know. */
const UNKNOWN_STATUS: TaskStatus = 'idle'

const text = (label: string, fallback = '') => orDefault(label, z.string(), fallback)
const maybeText = (label: string) => orDefault(label, z.string().nullable(), null)
const flag = (label: string, fallback = false) => orDefault(label, z.boolean(), fallback)
const amount = (label: string) => orDefault(label, z.number(), 0)
const texts = (label: string) => orDefault(label, z.array(z.string()), [])

/** Fields every task response carries, read leniently where the UI only renders them. */
export const taskFields = {
  id: z.string(),
  title: text('title', 'Untitled agent'),
  repo_id: maybeText('repo_id'),
  repo_slug: maybeText('repo_slug'),
  repos: lenientArray(
    'repo',
    z.object({ id: z.string(), slug: z.string(), dir: z.string(), worktree: flag('repo worktree') }),
  ),
  dirs: texts('dirs'),
  cwd: text('cwd'),
  worktree: flag('worktree'),
  sandbox: flag('sandbox', true),
  profile_id: text('profile_id', DEFAULT_PROFILE_ID),
  seti_control: orDefault<SetiControlLevel>('seti_control', setiControlLevel, 'off'),
  bypass_until: maybeText('bypass_until'),
  pr_urls: texts('pr_urls'),
  input_mode: orDefault<InputMode>('input_mode', z.enum(INPUT_MODES), 'wake'),
  session_id: maybeText('session_id'),
  source_session_id: maybeText('source_session_id'),
  status: orDefault<TaskStatus>('status', z.enum(TASK_STATUSES), UNKNOWN_STATUS),
  permission_mode: maybeText('permission_mode'),
  model: maybeText('model'),
  model_fallback: opaque<ModelFallback>('model_fallback'),
  cost_usd: amount('cost_usd'),
  outward_count: amount('outward_count'),
  last_error: maybeText('last_error'),
  created_at: z.string(),
  updated_at: z.string(),
  archived_at: maybeText('archived_at'),
  pinned: flag('pinned'),
  color: orDefault<AgentColor | null>('color', storedAgentColor.nullable(), null),
  setup: opaque<TaskSetup>('setup'),
  warm_caches: lenientArray('warm cache', opaque<WarmCacheSeed>('warm cache')).transform((seeds) =>
    seeds.filter((seed) => seed !== null),
  ),
  workspace_id: text('workspace_id'),
  notifications_muted: flag('notifications_muted'),
  status_line: maybeText('status_line'),
  status_line_at: maybeText('status_line_at'),
  unseen: flag('unseen'),
  asking: flag('asking'),
  closing_line: maybeText('closing_line'),
  blocked: maybeText('blocked'),
}

export const taskSchema = z.object(taskFields) satisfies ResponseSchema<Task>
