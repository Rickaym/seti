import { z } from 'zod'
import type { EaNoticeSeverity } from './ea.js'

/** What a task does with updates from outside the conversation: wake, hold or drop them. */
export const INPUT_MODES = ['wake', 'queue', 'off'] as const
export type InputMode = (typeof INPUT_MODES)[number]

export const PR_INPUT_KINDS = ['ci_failed', 'ci_passed', 'review', 'comment', 'conflict', 'merged', 'closed'] as const
export type PrInputKind = (typeof PR_INPUT_KINDS)[number]

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
}

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
export type TaskInput = PrInput | TeamInput | WorkspaceInput | ChannelInput | AgentInput | SetiInput

/** Updates of these sources start a turn in a task that wakes on updates. */
export const WAKING_SOURCES: readonly TaskInput['source'][] = ['pr', 'channel', 'agent', 'seti']

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
