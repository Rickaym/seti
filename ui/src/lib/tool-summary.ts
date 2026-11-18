import { sandboxViolations, WEBFETCH_BLOCKED } from '@seti/shared'
import { elapsedLabel } from '@/lib/time'
import { inputString, type ToolUseBlock } from '@/lib/transcript'

/** What a tool does, for its icon and for the words of a group's label. */
export type ToolKind = 'command' | 'monitor' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'todo' | 'mcp' | 'other'

const KINDS: Partial<Record<string, ToolKind>> = {
  Bash: 'command',
  BashOutput: 'command',
  KillBash: 'command',
  KillShell: 'command',
  Monitor: 'monitor',
  Read: 'read',
  NotebookRead: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  ToolSearch: 'search',
  WebSearch: 'search',
  WebFetch: 'web',
  Agent: 'agent',
  Task: 'agent',
  TodoWrite: 'todo',
  TaskCreate: 'todo',
  TaskUpdate: 'todo',
  TaskList: 'todo',
  TaskGet: 'todo',
}

export function toolKind(name: string): ToolKind {
  return KINDS[name] ?? (name.startsWith('mcp__') ? 'mcp' : 'other')
}

/** A tool's short name, and the MCP server it comes from when it has one. */
export function toolName(name: string): { name: string; server: string | null } {
  const parts = name.split('__')
  if (parts[0] !== 'mcp' || parts.length < 3) {
    return { name, server: null }
  }
  return { name: parts.slice(2).join('__'), server: parts[1] ?? null }
}

/** Longest summary kept in the DOM; the row truncates it further to fit. */
const SUMMARY_MAX = 240

const oneLine = (text: string) => {
  const line = text.replace(/\s+/gu, ' ').trim()
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX)}...` : line
}

// Each character has one way to match, so a failed match backtracks in linear time.
const WORD = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\([^)]*\)|\$(?!\([^)]*\))|[^\s;&|"'$])+`
const JOINER = String.raw`(?:\s*(?:&&|;)\s*|\s+|$)`
const CD_PREFIX = new RegExp(String.raw`^(?:cd|pushd)\s+${WORD}\s*(?:(?:&&|;)\s*|$)`, 'u')
const ASSIGN_PREFIX = new RegExp(String.raw`^(?:export\s+)?[A-Za-z_]\w*=(?:${WORD})?${JOINER}`, 'u')
const SET_LINE = /^set\s+[-+]\w+(?:\s+\w+)*\s*$/u
const HEREDOC = /(?<!<)<<-?\s*(["']?)([\w.-]+)\1/gu

/** A line without the `cd dir &&`, `export` and `VAR=value` that only set up the real command. */
function stripSetup(line: string): string {
  let rest = line.trim()
  for (;;) {
    const next = rest.replace(CD_PREFIX, '').replace(ASSIGN_PREFIX, '').trim()
    if (next === rest) {
      return rest
    }
    rest = next
  }
}

/** A line that runs something: not blank, a comment, a `set` option, a bare redirect or a bracket. */
const meaningful = (line: string) =>
  /\w/u.test(line) && !line.startsWith('#') && !line.startsWith('<<') && !SET_LINE.test(line)

/** The first line of a shell command that says what it does, skipping setup and heredoc bodies. */
export function commandSummary(command: string): string {
  const terminators: string[] = []
  for (const raw of command.split('\n')) {
    const waiting = terminators[0]
    if (waiting !== undefined) {
      if (raw.trim() === waiting) {
        terminators.shift()
      }
      continue
    }
    for (const match of raw.matchAll(HEREDOC)) {
      terminators.push(match[2] ?? '')
    }
    const stripped = stripSetup(raw)
    const line = stripped.endsWith('\\') ? stripped.slice(0, -1).trimEnd() : stripped
    if (meaningful(line)) {
      return oneLine(line)
    }
  }
  return oneLine(command.split('\n').find((line) => line.trim() !== '') ?? '')
}

function firstString(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }
  return Object.values(input).find((value): value is string => typeof value === 'string' && value.trim() !== '')
}

type Field = (key: string) => string | undefined

function searchSummary(field: Field): string {
  const pattern = field('pattern') ?? field('query') ?? ''
  const where = field('path')
  return where === undefined ? pattern : `${pattern} in ${where}`
}

function shellSummary(field: Field): string {
  const command = field('command')
  return field('description') ?? (command === undefined ? '' : commandSummary(command))
}

/** What a todo tool call did to the list: an item added, one changed, or the whole list written. */
function todoSummary(field: Field, input: unknown): string {
  const todos = typeof input === 'object' && input !== null ? (input as { todos?: unknown }).todos : undefined
  if (Array.isArray(todos)) {
    const done = todos.filter((todo: unknown) => (todo as { status?: unknown } | null)?.status === 'completed')
    return `${String(todos.length)} items, ${String(done.length)} done`
  }
  const id = field('taskId')
  if (id === undefined) {
    return field('subject') ?? 'list'
  }
  const change = field('status')?.replace('_', ' ') ?? field('subject') ?? 'read'
  return `#${id} ${change}`
}

const SUMMARIES: Record<ToolKind, (field: Field, input: unknown) => string> = {
  command: shellSummary,
  monitor: shellSummary,
  read: (field) => field('file_path') ?? field('notebook_path') ?? '',
  edit: (field) => field('file_path') ?? field('notebook_path') ?? '',
  search: searchSummary,
  web: (field) => field('url') ?? '',
  agent: (field) => field('description') ?? '',
  todo: todoSummary,
  mcp: (field, input) => field('description') ?? firstString(input) ?? JSON.stringify(input),
  other: (field, input) => field('description') ?? field('skill') ?? firstString(input) ?? JSON.stringify(input),
}

/** One short line saying what a call does: its description, file, pattern or first command line. */
export const toolSummary = (block: ToolUseBlock): string =>
  oneLine(SUMMARIES[toolKind(block.name)]((key) => inputString(block.input, key), block.input))

/** The command line behind a summary that shows a description instead, for hover text. */
export function commandLine(block: ToolUseBlock): string | undefined {
  const command = inputString(block.input, 'command')
  return command === undefined ? undefined : commandSummary(command)
}

const EXIT_CODE = /^Exit code (\d+)/u

/** The exit code a failed shell call reported, if it reported one. */
export function exitCode(output: string): number | null {
  const match = EXIT_CODE.exec(output.trimStart())
  return match === null ? null : Number(match[1])
}

const LABELS: Record<ToolKind, [one: string, many: string]> = {
  command: ['ran 1 command', 'ran # commands'],
  monitor: ['watched 1 command', 'watched # commands'],
  read: ['read 1 file', 'read # files'],
  edit: ['edited 1 file', 'edited # files'],
  search: ['ran 1 search', 'ran # searches'],
  web: ['fetched 1 page', 'fetched # pages'],
  agent: ['started 1 subagent', 'started # subagents'],
  todo: ['updated the todo list', 'updated the todo list # times'],
  mcp: ['made 1 MCP call', 'made # MCP calls'],
  other: ['used 1 tool', 'used # tools'],
}

/** What a run of calls did, by kind in order of first use: "Ran 4 commands, read 2 files". */
export function groupLabel(names: readonly string[]): string {
  const counts = new Map<ToolKind, number>()
  for (const name of names) {
    const kind = toolKind(name)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const text = [...counts]
    .map(([kind, count]) => {
      const [one, many] = LABELS[kind]
      return count === 1 ? one : many.replace('#', String(count))
    })
    .join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export interface KindTally {
  kind: ToolKind
  names: string[]
  count: number
  failed: number
}

/** Tallies a run of calls by kind in order of first use, for one icon per kind. */
export function kindTallies(calls: readonly { name: string; failed: boolean }[]): KindTally[] {
  const tallies = new Map<ToolKind, KindTally>()
  for (const { name, failed } of calls) {
    const kind = toolKind(name)
    const tally = tallies.get(kind) ?? { kind, names: [], count: 0, failed: 0 }
    const short = toolName(name).name
    if (!tally.names.includes(short)) {
      tally.names.push(short)
    }
    tally.count += 1
    tally.failed += failed ? 1 : 0
    tallies.set(kind, tally)
  }
  return [...tallies.values()]
}

/** Hover text for a kind's icon: "Bash: 10, 1 failed". */
export function tallyTitle({ names, count, failed }: KindTally): string {
  const text = `${names.join(', ')}: ${String(count)}`
  return failed > 0 ? `${text}, ${String(failed)} failed` : text
}

/** A call's duration from the call to its result, left out under a second. */
export function durationOf(startedAt: string, endedAt: string | undefined): string | null {
  if (endedAt === undefined) {
    return null
  }
  const ms = Date.parse(endedAt) - Date.parse(startedAt)
  return ms >= 1000 ? elapsedLabel(ms) : null
}

/** A call that leaves a process running past its result: a Monitor or a background shell. */
export const startsBackground = (block: ToolUseBlock): boolean =>
  block.name === 'Monitor' ||
  (typeof block.input === 'object' && block.input !== null && Reflect.get(block.input, 'run_in_background') === true)

/** What the sandbox or the WebFetch allowlist refused in a call, one line each. */
export function refusals(text: string): string[] {
  const webFetch = text.split('\n').filter((line) => line.includes(WEBFETCH_BLOCKED))
  return [...sandboxViolations(text), ...webFetch.map((line) => line.trim())]
}
