import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  displayStatus,
  prStates,
  todoProgress,
  todoText,
  type AgentTodo,
  type LinkedPrState,
  type MessageRow,
  type PullRequest,
  type SubtaskBrief,
  type Task,
  type TaskDisplayStatus,
  type TeamMessage,
} from '@seti/shared'
import { toolLabel } from './digest.js'

const LINE_CHARS = 600
const QUOTE_CHARS = 150
const TOOL_CHARS = 110
const SHOWN_PRS = 3
const SHOWN_SUBAGENTS = 2
export const LISTED_MIN_PRIORITY = 40
export const LISTED_MAX = 24
const MINUTE = 60_000
export const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type OpenPrView = Pick<
  PullRequest,
  | 'url'
  | 'repo_slug'
  | 'number'
  | 'title'
  | 'author'
  | 'draft'
  | 'ci'
  | 'checks'
  | 'unresolved_threads'
  | 'review_decision'
  | 'mergeable'
  | 'preview'
>

/** Everything the live context is built from, read in one pass so rendering stays pure. */
export interface ContextInput {
  now: number
  tasks: readonly Task[]
  prStates: ReadonlyMap<string, Readonly<Record<string, LinkedPrState>>>
  /** Tasks with an open Claude Code process: background work and subagents started in it. */
  sessions: ReadonlyMap<string, { background: number; subagents: readonly SubtaskBrief[] }>
  waiting: ReadonlyMap<string, number>
  /** Recent messages of the listed tasks' own agents, newest first. */
  activity: ReadonlyMap<string, readonly MessageRow[]>
  /** The todo lists of the listed tasks' agents; tasks without one are missing. */
  todos: ReadonlyMap<string, readonly AgentTodo[]>
  /** Null while GitHub has not answered yet. */
  prs: readonly OpenPrView[] | null
  viewer: string | null
  notable: readonly MessageRow[]
  /** Channels the EA subscribes to; task updates from other channels stay out of the context. */
  eaChannels: ReadonlySet<string>
  /** The newest group chat messages, oldest first. */
  team: readonly TeamMessage[]
  /** The name of each agent's role pack, by task id. */
  roles: ReadonlyMap<string, string>
}

export interface Line {
  text: string
  priority: number
  /** What the line is about, so a section can summarise the lines left out. */
  key?: string
}

export interface Section {
  heading: string
  lines: Line[]
  /** A line standing in for the lines left out, or null when none were. */
  rest: (hidden: readonly Line[]) => string | null
  /** How many leading lines survive trimming, so the section never shrinks to its heading. */
  keep?: number
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat
}

export const quote = (text: string) => `"${clip(text, QUOTE_CHARS)}"`

/** A span such as 45s, 12m, 3h 5m or 2d. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${String(seconds)}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${String(minutes)}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) {
    return `${String(Math.floor(hours / 24))}d`
  }
  const rest = minutes % 60
  return rest === 0 || hours >= 6 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`
}

export const since = (now: number, at: string) => now - Date.parse(at)

export const repoName = (slug: string) => slug.split('/').at(-1) ?? slug

/** `seti#91` for a GitHub PR URL. */
function prLabel(url: string): string {
  const match = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url)
  return match === null ? url : `${match[1] ?? ''}#${match[2] ?? ''}`
}

export const CI_WORDS: Record<NonNullable<OpenPrView['ci']>, string> = {
  success: 'CI green',
  failure: 'CI failing',
  pending: 'CI running',
  neutral: 'CI neutral',
}

export interface TaskView {
  task: Task
  status: TaskDisplayStatus
  priority: number
  running_subagents: SubtaskBrief[]
  background: number
  waiting: number
}

/** The priority of the first step whose age limit the age is under, else the last priority. */
const byAge =
  (steps: readonly (readonly [number, number])[], older: number) =>
  (age: number): number =>
    steps.find(([limit]) => age < limit)?.[1] ?? older

const PRIORITY: Record<TaskDisplayStatus, (age: number) => number> = {
  running: () => 100,
  blocked: () => 100,
  error: byAge([[DAY, 90]], 30),
  asking: byAge([[DAY, 85]], 30),
  idle: byAge(
    [
      [HOUR, 70],
      [6 * HOUR, 60],
      [DAY, 50],
    ],
    10,
  ),
  complete: byAge([[DAY, 45]], 5),
  stopped: byAge([[6 * HOUR, 55]], 8),
  interrupted: byAge([[6 * HOUR, 55]], 8),
}

const BACKGROUND_PRIORITY = 95
const WAITING_PRIORITY = 85

const hasBackground = (view: Pick<TaskView, 'status' | 'running_subagents' | 'background'>) =>
  view.status !== 'running' && (view.running_subagents.length > 0 || view.background > 0)

/** Tasks with their shown status and how much they matter now, most first. */
export function taskViews(
  input: Pick<ContextInput, 'now' | 'tasks' | 'prStates' | 'sessions' | 'waiting'>,
): TaskView[] {
  return input.tasks
    .map((task) => {
      // Subagents of an idle task are reported apart from the main agent, so they are left out here.
      const status = displayStatus(task, prStates(input.prStates.get(task.id) ?? {}), 0)
      const session = input.sessions.get(task.id)
      const running = session?.subagents.filter((sub) => sub.status === 'running') ?? []
      const background = Math.max(session?.background ?? 0, running.filter((sub) => sub.background).length)
      const waiting = input.waiting.get(task.id) ?? 0
      const age = since(input.now, task.updated_at)
      let priority = PRIORITY[status](age)
      if (hasBackground({ status, running_subagents: running, background })) {
        priority = BACKGROUND_PRIORITY
      } else if (waiting > 0 && status !== 'running') {
        priority = Math.max(priority, WAITING_PRIORITY)
      }
      const freshness = 1 - Math.min(age / (7 * DAY), 1)
      return { task, status, priority: priority + freshness * 0.9, running_subagents: running, background, waiting }
    })
    .toSorted((a, b) => b.priority - a.priority)
}

type AssistantContent = SDKAssistantMessage['message']['content']

function lastBlockLine(content: AssistantContent, toolDone: boolean): string | null {
  const block = content.at(-1)
  if (block?.type === 'tool_use') {
    return `${toolDone ? 'just ran' : 'running'} ${clip(toolLabel(block), TOOL_CHARS)}`
  }
  const text = content.findLast((part) => part.type === 'text' && part.text.trim() !== '')
  return text?.type === 'text' ? `said ${quote(text.text)}` : null
}

/** What a running agent does now: the tool it waits on, or what it last said. */
function nowLine(rows: readonly MessageRow[]): string | null {
  for (const [index, row] of rows.entries()) {
    if (row.kind === 'sdk' && row.payload.type === 'assistant') {
      const later = rows.slice(0, index).some((r) => r.kind === 'sdk' && r.payload.type === 'user')
      return lastBlockLine(row.payload.message.content, later)
    }
  }
  return null
}

const RESULT_ENDINGS: Partial<Record<string, string>> = {
  error_during_execution: 'its last turn ended with an error',
  error_max_turns: 'its last turn stopped at the turn limit',
  error_max_budget_usd: 'its last turn stopped at the budget limit',
  error_max_structured_output_retries: 'its last turn stopped after too many output retries',
}

/** How a task's last turn ended: its final words, or why it stopped. */
function lastLine(rows: readonly MessageRow[]): string | null {
  for (const row of rows) {
    if (row.kind !== 'sdk') {
      continue
    }
    const m = row.payload
    if (m.type === 'result') {
      if (m.subtype !== 'success') {
        return RESULT_ENDINGS[m.subtype] ?? 'its last turn ended'
      }
      return m.is_error ? `last turn failed: ${quote(m.result)}` : `last reply ${quote(m.result)}`
    }
    if (m.type === 'assistant') {
      return lastBlockLine(m.message.content, true)
    }
  }
  return null
}

function idleTag(view: TaskView, age: string): string {
  const busy = Math.max(view.running_subagents.length, view.background)
  return busy > 0
    ? `RUNNING SUBAGENTS: main agent idle ${age}, ${String(busy)} background subagents running`
    : `IDLE ${age}`
}

function statusTag(view: TaskView, now: number): string {
  const age = span(since(now, view.task.updated_at))
  const subs = view.running_subagents.length
  switch (view.status) {
    case 'running':
      return subs > 0 ? `RUNNING for ${age}, ${String(subs)} subagents running` : `RUNNING for ${age}`
    case 'complete':
      return `COMPLETE, idle ${age}`
    case 'error':
      return `ERROR ${age} ago`
    case 'asking':
      return `ASKING YOU, idle ${age}`
    case 'blocked':
      return `WAITS ON THE USER: ${quote(view.task.blocked ?? 'blocked')}`
    case 'idle':
      return idleTag(view, age)
    case 'stopped':
    case 'interrupted':
      return `${view.status.toUpperCase()} ${age} ago`
  }
}

function prState(url: string, open: ReadonlyMap<string, OpenPrView>, states: Readonly<Record<string, LinkedPrState>>) {
  const pr = open.get(url)
  if (pr !== undefined) {
    return `${prLabel(url)} ${pr.ci === null ? 'open' : CI_WORDS[pr.ci]}`
  }
  const state = states[url]
  return state === undefined ? prLabel(url) : `${prLabel(url)} ${state}`
}

const more = (count: number, shown: number) => (count > shown ? ` and ${String(count - shown)} more` : '')

function subagentLine(subs: readonly SubtaskBrief[], now: number): string | null {
  if (subs.length === 0) {
    return null
  }
  const shown = subs.slice(0, SHOWN_SUBAGENTS).map((sub) => {
    const kind = sub.subagent_type === null ? '' : `${sub.subagent_type}, `
    return `${quote(sub.description)} (${kind}${span(since(now, sub.started_at))})`
  })
  return `subagents ${shown.join(', ')}${more(subs.length, SHOWN_SUBAGENTS)}`
}

function todoLine(todos: readonly AgentTodo[]): string | null {
  const { done, total, current } = todoProgress(todos)
  if (total === 0) {
    return null
  }
  const now = current === null ? '' : `, now ${quote(todoText(current))}`
  return `todos ${String(done)}/${String(total)} done${now}`
}

function waitingLine(view: TaskView): string | null {
  if (view.waiting === 0) {
    return null
  }
  const held = view.task.input_mode === 'wake' ? '' : ', held for the user'
  return `${String(view.waiting)} ${view.waiting === 1 ? 'update' : 'updates'} waiting${held}`
}

function prsLine(view: TaskView, input: ContextInput, open: ReadonlyMap<string, OpenPrView>): string | null {
  const urls = view.task.pr_urls
  if (urls.length === 0) {
    return null
  }
  const states = input.prStates.get(view.task.id) ?? {}
  const shown = urls.slice(-SHOWN_PRS).map((url) => prState(url, open, states))
  return `PRs ${shown.join(', ')}${more(urls.length, SHOWN_PRS)}`
}

function taskLine(view: TaskView, input: ContextInput, open: ReadonlyMap<string, OpenPrView>): string {
  const { task } = view
  const rows = input.activity.get(task.id) ?? []
  const repo = task.repo_slug === null ? '' : ` (${repoName(task.repo_slug)})`
  const running = view.status === 'running'
  const activity = running ? nowLine(rows) : lastLine(rows)
  const role = input.roles.get(task.id) ?? null
  const parts = [
    `${quote(task.title)}${repo} ${statusTag(view, input.now)}`,
    role === null ? null : `role ${quote(role)}`,
    view.status === 'error' && task.last_error !== null ? `error: ${clip(task.last_error, 120)}` : null,
    activity !== null && running ? `now ${activity}` : activity,
    subagentLine(view.running_subagents, input.now),
    todoLine(input.todos.get(task.id) ?? []),
    waitingLine(view),
    prsLine(view, input, open),
  ]
  return `- ${clip(parts.filter((part) => part !== null).join('; '), LINE_CHARS)}`
}

function countWords(views: readonly TaskView[]): string {
  const counts = new Map<string, number>()
  for (const view of views) {
    const word = hasBackground(view) ? 'running subagents' : view.status
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.entries()].map(([word, count]) => `${String(count)} ${word}`).join(', ')
}

/** The tasks that matter now, one line each, and a count of the rest. */
export function taskSection(
  views: readonly TaskView[],
  input: ContextInput,
  open: ReadonlyMap<string, OpenPrView>,
): Section {
  const listed = views.filter((view) => view.priority >= LISTED_MIN_PRIORITY).slice(0, LISTED_MAX)
  const unlisted = views.slice(listed.length)
  const heading =
    views.length === 0
      ? 'Tasks: none.'
      : `Tasks: ${String(views.length)} in all; ${countWords(views)}. Most urgent first:`
  return {
    heading,
    lines: listed.map((view) => ({ text: taskLine(view, input, open), priority: view.priority, key: view.task.id })),
    rest: (hidden) => {
      const keys = new Set(hidden.map((line) => line.key))
      const others = [...listed.filter((view) => keys.has(view.task.id)), ...unlisted]
      if (others.length === 0) {
        return null
      }
      const newest = Math.min(...others.map((view) => since(input.now, view.task.updated_at)))
      return `Not listed: ${String(others.length)} more (${countWords(others)}), last changed ${span(newest)} ago or earlier.`
    },
  }
}
