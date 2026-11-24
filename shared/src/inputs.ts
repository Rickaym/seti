import { z } from 'zod'
import type { DeliveryTiming } from './channel-delivery.js'
import type { EaNoticeSeverity } from './ea.js'

/** What a task does with updates from outside the conversation: wake, hold or drop them. */
export const INPUT_MODES = ['wake', 'queue', 'off'] as const
export type InputMode = (typeof INPUT_MODES)[number]

export const PR_INPUT_KINDS = ['ci_failed', 'ci_passed', 'review', 'comment', 'conflict', 'merged', 'closed'] as const
export type PrInputKind = (typeof PR_INPUT_KINDS)[number]

/**
 * Why Seti recorded a PR update without starting a turn for it. The agent never reads its own
 * action or a repeat; a pass nobody waited for goes along with its next turn.
 */
export type PrQuietReason = 'own_action' | 'repeat' | 'nothing_pending'

/** How a quiet update is marked wherever updates are listed. */
export const QUIET_LABELS: Record<PrQuietReason, string> = {
  own_action: 'not sent: own action',
  repeat: 'not sent: repeat',
  nothing_pending: 'no wake: nothing pending',
}

interface InputBase {
  /** What the update is about, such as `owner/repo#123`. */
  subject: string
  title: string
  /** Markdown the transcript shows and the agent reads. */
  body: string
  url: string | null
  /** When the user dismissed the update unread; the agent never gets it. */
  dismissed_at?: string
}

/** The subagent whose work an update concerns, as it stood when Seti routed the update. */
export interface InputSubtask {
  /** Id of the Agent tool call that started the subagent. */
  tool_use_id: string
  description: string
  /** The id SendMessage addresses the subagent by; null when Claude Code never reported one. */
  agent_id: string | null
  running: boolean
}

/** A change on a linked pull request: CI, reviews, comments, conflicts or its end. */
export interface PrInput extends InputBase {
  source: 'pr'
  kind: PrInputKind
  /** The subagent the PR is linked to; its parent agent gets the update addressed to it. */
  subtask?: InputSubtask
  /** Set when Seti only recorded the update, with the reason. */
  quiet?: PrQuietReason
}

/** A team chat message for this task: it mentioned the task, went to it alone, or to every one. */
export interface TeamInput extends InputBase {
  source: 'team'
  kind: 'mention' | 'direct' | 'broadcast'
  message_id: number
}

/** An edit to a file of the task's Seti workspace that Seti did not apply; subject is the file. */
export interface WorkspaceInput extends InputBase {
  source: 'workspace'
  kind: 'rejected'
}

/** An event from a webhook channel the task subscribes to; subject is what reported it. */
export interface ChannelInput extends InputBase {
  source: 'channel'
  /** The event kind, such as pull_request.opened; empty when the sender gave none. */
  kind: string
  channel: string
  channel_id: string
  event_id: number
  severity: EaNoticeSeverity
  received_at: string
  /** When the subscription has the agent get it; absent follows the agent's update mode. */
  delivery?: DeliveryTiming
}

/** A reply in an outside thread the agent posted in, such as on Slack; subject is who wrote it. */
export interface ThreadInput extends InputBase {
  source: 'thread'
  kind: 'reply'
  /** Where the thread lives, such as slack. */
  service: string
  /** The conversation, such as a Slack channel id. */
  channel: string
  thread: string
  /** The reply's own id, such as its Slack ts. */
  message: string
  /** The author's id in that service, such as a Slack user or bot id. */
  from: string
  bot: boolean
  follow_id: number
  received_at: string
  /** A bot's reply waits for the user's next message; absent follows the agent's update mode. */
  delivery?: DeliveryTiming
}

/** Whether an update waits for the user's next message, whatever else starts a turn meanwhile. */
export const heldForMessage = (input: TaskInput) =>
  (input.source === 'channel' || input.source === 'thread') && input.delivery === 'with_message'

/** How a turn of another agent ended, for an agent that asked Seti to tell it. */
export const AGENT_INPUT_KINDS = ['idle', 'error', 'stopped'] as const
export type AgentInputKind = (typeof AGENT_INPUT_KINDS)[number]

/** Another agent's turn ended; subject is its title and body its final message or error. */
export interface AgentInput extends InputBase {
  source: 'agent'
  kind: AgentInputKind
  task_id: string
}

/** How the user answered a change the agent asked for; subject names the change. */
export interface SetiInput extends InputBase {
  source: 'seti'
  kind: 'allowed' | 'denied' | 'expired'
  request_id: string
}

/** An update from outside the conversation that the task's agent receives on its next turn. */
export type TaskInput = PrInput | TeamInput | WorkspaceInput | ChannelInput | ThreadInput | AgentInput | SetiInput

/** Why Seti started no turn for the update, or undefined for one that waits for the agent. */
export const quietReason = (input: TaskInput): PrQuietReason | undefined =>
  input.source === 'pr' ? input.quiet : undefined

/** Updates of these sources start a turn in a task that wakes on updates. */
export const WAKING_SOURCES: readonly TaskInput['source'][] = ['pr', 'channel', 'thread', 'agent', 'seti']

/** Dismisses the updates waiting for the agent, up to the newest one the user saw. */
export const dismissInputsInput = z.object({ up_to: z.number().int().positive() })

/** How many waiting updates a dismissal discarded, and of which sources. */
export interface InputsDismissed {
  count: number
  sources: TaskInput['source'][]
}

const SOURCE_NOUNS: Record<TaskInput['source'], readonly [string, string]> = {
  pr: ['PR update', 'PR updates'],
  team: ['group chat message', 'group chat messages'],
  channel: ['channel event', 'channel events'],
  thread: ['thread reply', 'thread replies'],
  workspace: ['workspace notice', 'workspace notices'],
  agent: ['agent update', 'agent updates'],
  seti: ['answered request', 'answered requests'],
}

/** How many updates of each source, such as `2 PR updates, 1 group chat message`. */
export function sourceCounts(sources: readonly TaskInput['source'][]): string {
  const tally = new Map<TaskInput['source'], number>()
  for (const source of sources) {
    tally.set(source, (tally.get(source) ?? 0) + 1)
  }
  return [...tally].map(([source, count]) => `${String(count)} ${SOURCE_NOUNS[source][count === 1 ? 0 : 1]}`).join(', ')
}

/** Whether a wake task holds its updates after a burst of automatic turns. */
export interface InputPause {
  /** When Seti hands the waiting updates over by itself; null when it is not paused. */
  paused_until: string | null
}
