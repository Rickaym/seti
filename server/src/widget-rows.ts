import {
  listedStatus,
  todoProgress,
  todoText,
  waitsOnYou,
  WIDGET_LIMITS,
  WIDGET_REASONS,
  WIDGET_RECENT_MS,
  type CiState,
  type LinkedPrState,
  type TaskDisplayStatus,
  type TaskListEntry,
  type WidgetAgent,
  type WidgetAgentRow,
  type WidgetPr,
  type WidgetReason,
  type WidgetState,
  type WidgetSubagent,
} from '@seti/shared'
import { toolName } from './digest.js'
import { redactSecrets } from './scrub.js'

/** What the cached GitHub listing says about an open PR. */
export interface OpenPrFacts {
  ci: CiState | null
  unresolved_threads: number
}

/** Everything an overview row is built from besides the agent itself. */
export interface RowContext {
  showNames: boolean
  /** Open PRs by URL. */
  openPrs: ReadonlyMap<string, OpenPrFacts>
  /** Workspace names by id; null when Seti has only one workspace. */
  workspaces: ReadonlyMap<string, string> | null
  /** The tool the agent's own agent runs now, by its raw name. */
  ownTool: (taskId: string) => string | null
}

/** One line, credentials redacted before the cut so no part of one is left behind. */
function clip(text: string, max: number): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat
}

/** What a waiting agent's line says when the device hides names. */
const GENERIC_REASONS: Record<WidgetReason, string> = {
  blocked: 'Waits for your approval',
  asking: 'Asks you something',
  error: 'Its turn failed',
  interrupted: 'Cut off by a restart',
}

const REASON_SET: ReadonlySet<string> = new Set(WIDGET_REASONS)

export const isReason = (status: TaskDisplayStatus): status is WidgetReason => REASON_SET.has(status)

/** A label that tells agents apart without saying what they work on. */
export const genericTitle = (taskId: string) => `Agent ${taskId.replaceAll('-', '').slice(0, 4)}`

const titleOf = (task: Pick<TaskListEntry, 'id' | 'title'>, showNames: boolean) =>
  showNames ? clip(task.title, WIDGET_LIMITS.title) : genericTitle(task.id)

const agentPath = (taskId: string) => `/#agents/${encodeURIComponent(taskId)}`

/** A waiting agent; `line` is the reason Seti's notifications give, shown only with names. */
export function waitingAgent(
  entry: TaskListEntry,
  reason: WidgetReason,
  line: string,
  showNames: boolean,
): WidgetAgent {
  return {
    task_id: entry.id,
    title: titleOf(entry, showNames),
    color: entry.color,
    reason,
    line: showNames && line !== '' ? clip(line, WIDGET_LIMITS.line) : GENERIC_REASONS[reason],
    since: entry.updated_at,
    path: agentPath(entry.id),
  }
}

function stateOf(entry: TaskListEntry, status: TaskDisplayStatus = listedStatus(entry)): WidgetState {
  if (waitsOnYou(entry, status)) {
    return 'waiting'
  }
  if (status === 'running') {
    return 'running'
  }
  if (status === 'error' || status === 'interrupted') {
    return 'failed'
  }
  return status === 'complete' ? 'complete' : 'idle'
}

const STATE_RANK: Record<WidgetState, number> = { running: 0, waiting: 1, failed: 2, complete: 2, idle: 2 }

/** Running agents, then waiting ones, then those that changed recently; newest first in each. */
export function overviewOrder(entries: readonly TaskListEntry[], now: number): TaskListEntry[] {
  const ranked = entries.map((entry) => ({ entry, state: stateOf(entry), at: Date.parse(entry.updated_at) }))
  return ranked
    .filter(({ state, at }) => STATE_RANK[state] < 2 || now - at <= WIDGET_RECENT_MS)
    .sort((a, b) =>
      STATE_RANK[a.state] === STATE_RANK[b.state] ? b.at - a.at : STATE_RANK[a.state] - STATE_RANK[b.state],
    )
    .map(({ entry }) => entry)
}

function activityOf(entry: TaskListEntry, state: WidgetState, waitLine: string | null): string | null {
  if (state === 'waiting') {
    return waitLine
  }
  if (state === 'failed') {
    const cause = entry.status === 'interrupted' ? 'Cut off by a restart' : (entry.last_error ?? '').split('\n')[0]
    return cause === '' || cause === undefined ? 'Failed' : cause
  }
  const current = todoProgress(entry.todos).current
  if (state === 'running') {
    return entry.status_line ?? (current === null ? null : todoText(current))
  }
  return entry.status_line
}

function subagentsOf(entry: TaskListEntry, showNames: boolean): WidgetSubagent[] {
  return entry.running_subtasks.slice(0, WIDGET_LIMITS.subagents).map((subtask) => {
    const kind = subtask.subagent_type ?? 'Subagent'
    const named = subtask.description === '' ? kind : `${kind}: ${subtask.description}`
    const last = subtask.progress?.last_tool ?? null
    return {
      label: clip(showNames ? named : kind, WIDGET_LIMITS.label),
      tool: last === null ? null : clip(toolName(last), WIDGET_LIMITS.label),
    }
  })
}

const PR_PATH = /github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/

/** `repo#123` for a GitHub PR URL. */
export function prLabel(url: string): string {
  const match = PR_PATH.exec(url)
  return match === null ? url : `${match[1] ?? ''}#${match[2] ?? ''}`
}

interface PrCandidate {
  url: string
  state: LinkedPrState
  facts: OpenPrFacts | null
}

/** Failing CI first, then unresolved reviews, then any open PR, then landed ones. */
function prRank({ state, facts }: PrCandidate): number {
  if (state !== 'open') {
    return state === 'merged' ? 4 : 5
  }
  if (facts?.ci === 'failure') {
    return 0
  }
  return (facts?.unresolved_threads ?? 0) > 0 ? 1 : 2
}

function prOf(entry: TaskListEntry, ctx: RowContext): WidgetPr | null {
  const urls = [...new Set([...entry.pr_urls, ...Object.keys(entry.pr_states.by_url)])]
  const candidates = urls.map((url): PrCandidate => {
    const facts = ctx.openPrs.get(url) ?? null
    return { url, state: entry.pr_states.by_url[url] ?? 'open', facts }
  })
  const [best] = candidates.toSorted((a, b) => prRank(a) - prRank(b))
  if (best === undefined) {
    return null
  }
  const open = best.state === 'open'
  return {
    label: ctx.showNames ? prLabel(best.url) : null,
    state: best.state,
    ci: open ? (best.facts?.ci ?? null) : null,
    unresolved_threads: open ? (best.facts?.unresolved_threads ?? 0) : 0,
    more: candidates.length - 1,
  }
}

/** One overview row; `waitLine` is the waiting reason as `waitingAgent` shows it. */
export function agentRow(entry: TaskListEntry, ctx: RowContext, waitLine: string | null): WidgetAgentRow {
  const state = stateOf(entry)
  const activity = activityOf(entry, state, waitLine)
  const { done, total } = todoProgress(entry.todos)
  const tool = state === 'running' ? ctx.ownTool(entry.id) : null
  const workspace = ctx.showNames ? (ctx.workspaces?.get(entry.workspace_id) ?? null) : null
  return {
    task_id: entry.id,
    title: titleOf(entry, ctx.showNames),
    color: entry.color,
    state,
    activity: activity === null || (!ctx.showNames && state !== 'waiting') ? null : clip(activity, WIDGET_LIMITS.line),
    tool: tool === null ? null : clip(toolName(tool), WIDGET_LIMITS.label),
    todos: total === 0 ? null : { done, total },
    subagents: subagentsOf(entry, ctx.showNames),
    more_subagents: Math.max(0, entry.running_subtasks.length - WIDGET_LIMITS.subagents),
    pr: prOf(entry, ctx),
    workspace: workspace === null ? null : clip(workspace, WIDGET_LIMITS.label),
    since: entry.updated_at,
    path: agentPath(entry.id),
  }
}
