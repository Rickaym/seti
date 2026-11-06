import { z } from 'zod'
import type { CiState } from './prs.js'
import type { LinkedPrState } from './tasks.js'

/** Caps that keep the summary small enough for a phone to fetch every few minutes. */
export const WIDGET_LIMITS = Object.freeze({
  /** Agents that wait on the user, listed in full; `needs_you_count` counts every one. */
  waiting: 8,
  /** Agents the overview lists, running ones first. */
  agents: 8,
  /** Running subagents listed under each agent; `more_subagents` counts the rest. */
  subagents: 3,
  title: 60,
  line: 90,
  label: 48,
})

/** Idle agents updated within this long still show in the overview, as finished recently. */
export const WIDGET_RECENT_MS = 12 * 60 * 60 * 1000

/** Why an agent waits on the user: its turn failed, it asked something or a call needs approval. */
export const WIDGET_REASONS = ['error', 'interrupted', 'asking', 'blocked'] as const
export type WidgetReason = (typeof WIDGET_REASONS)[number]

/** One agent that waits on the user, with the path that opens it in Seti. */
export interface WidgetAgent {
  task_id: string
  /** The agent's title, or a generic label when the device hides names. */
  title: string
  /** The agent's colour as `#rrggbb`; null for none. */
  color: string | null
  reason: WidgetReason
  /** The one-line reason Seti's notifications show, such as `Asks to use Bash: terraform apply`. */
  line: string
  since: string
  path: string
}

/** How an agent in the overview stands; `waiting` is the same as being in `needs_you`. */
export type WidgetState = 'running' | 'waiting' | 'failed' | 'complete' | 'idle'

/** A subagent running under an agent. */
export interface WidgetSubagent {
  /** Its type and description, such as `Explore: find the widget code`; its type alone if hidden. */
  label: string
  /** The tool it used last, by name only. */
  tool: string | null
}

/** The most telling PR of an agent: a failing or reviewed open one before the rest. */
export interface WidgetPr {
  /** `repo#123`; null when the device hides names. */
  label: string | null
  state: LinkedPrState
  /** CI of the PR's head while it is open; null when unknown. */
  ci: CiState | null
  unresolved_threads: number
  /** The agent's other linked PRs. */
  more: number
}

/** One agent in the overview, with what it does now. */
export interface WidgetAgentRow {
  task_id: string
  title: string
  color: string | null
  state: WidgetState
  /** Its status line or todo step while running, its reason while waiting; null when hidden. */
  activity: string | null
  /** The tool its own agent runs now, by name only; null between calls and when it does not run. */
  tool: string | null
  /** Its todo list's progress; null without one. */
  todos: { done: number; total: number } | null
  subagents: WidgetSubagent[]
  more_subagents: number
  pr: WidgetPr | null
  /** Its workspace's name when Seti has more than one workspace and names show; else null. */
  workspace: string | null
  /** When it last changed, which for a finished agent is when it finished. */
  since: string
  path: string
}

export interface WidgetSummary {
  /** Waiting agents, longest waiting first, at most `WIDGET_LIMITS.waiting`. */
  needs_you: WidgetAgent[]
  /** Every agent that waits on the user, listed or not. */
  needs_you_count: number
  /** Running agents first, then waiting ones, then those that finished recently. */
  agents: WidgetAgentRow[]
  running: number
  idle: number
  /** What turns cost since midnight on the Seti host, in US dollars. */
  cost_today_usd: number
  /** True when this device shows generic labels in place of agent titles and other free text. */
  names_hidden: boolean
  updated_at: string
  /** Paths the app opens in the web view: Seti's start page and its agent list. */
  paths: { home: string; agents: string }
}

/** A paired device's widget settings, which only the user changes, in Seti. */
export const deviceWidgetInput = z.object({ show_names: z.boolean() })
export type DeviceWidgetInput = z.input<typeof deviceWidgetInput>
