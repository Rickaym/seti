import {
  compactedWithin,
  QUIET_LABELS,
  quietReason,
  type DigestKind,
  type DigestLine,
  type MessageRow,
  type PromptPayload,
  type RuntimeEvent,
  type ShellResult,
  type SubtaskBrief,
  type TaskInput,
  type ToolCall,
  rowEvents,
  toolEnds,
} from '@seti/shared'
import { redactCredentials, redactSecrets } from './scrub.js'

const USER_CHARS = 600
const AGENT_CHARS = 1200
const TOOL_CHARS = 160
const RESULT_CHARS = 160

type ToolEnd = Extract<RuntimeEvent, { type: 'tool.ended' }>
type TurnEnded = Extract<RuntimeEvent, { type: 'turn.ended' }>

/** Whether a call's successful output is file content or matches, which reads as noise. */
const quietResult = (call: ToolCall) => call.kind === 'read' || (call.kind === 'search' && call.search?.tools !== true)

/** Input fields that name what a tool other than a command worked on, in order of preference. */
const TARGET_FIELDS = ['file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'skill']

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Redacts before cutting, so a cut never leaves part of a credential behind. */
function clip(text: string, max: number): string {
  const flat = oneLine(redactCredentials(text))
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat
}

function field(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null || !(key in input)) {
    return null
  }
  const value: unknown = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** `mcp__clickup__clickup_get_task` reads as `clickup: clickup_get_task`. */
export function toolName(name: string): string {
  const [prefix, server, ...rest] = name.split('__')
  return prefix === 'mcp' && server !== undefined && rest.length > 0 ? `${server}: ${rest.join('__')}` : name
}

/** A tool call in a few words: its command, or its tool and what it works on. */
export function toolLabel(call: ToolCall): string {
  if (call.shell?.action === 'run') {
    const command = call.shell.command ?? ''
    return clip(command === '' ? call.name : redactSecrets(command), TOOL_CHARS)
  }
  const target =
    TARGET_FIELDS.map((key) => field(call.input, key)).find((value) => value !== null) ?? call.edit?.changes[0]?.path
  return clip(target === undefined ? toolName(call.name) : `${toolName(call.name)} ${target}`, TOOL_CHARS)
}

/** The first line of some output, and how many non-empty lines followed it. */
function firstLine(text: string, max: number): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const [first] = lines
  if (first === undefined) {
    return ''
  }
  const more = lines.length - 1
  return more > 0 ? `${clip(first, max)} (+${String(more)} lines)` : clip(first, max)
}

function outcome(call: ToolCall, end: ToolEnd | undefined): string {
  if (end === undefined) {
    return ''
  }
  const text = firstLine(end.result.text, RESULT_CHARS)
  if (end.status !== 'ok') {
    return text === '' ? ' Failed.' : ` Failed: ${text}`
  }
  return text === '' || quietResult(call) ? '' : ` Result: ${text}`
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
}

const TURN_ENDINGS: Record<NonNullable<TurnEnded['ending']>, string> = {
  error: 'Turn ended with an error',
  turn_limit: 'Turn stopped at the turn limit',
  budget_limit: 'Turn stopped at the budget limit',
  retry_limit: 'Turn stopped after too many output retries',
  other: 'Turn ended',
}

function turnEnd(event: TurnEnded): string {
  if (event.ending !== undefined) {
    return TURN_ENDINGS[event.ending]
  }
  return event.status === 'error'
    ? `Turn failed: ${clip(event.result, RESULT_CHARS)}`
    : `Turn finished in ${duration(event.durationMs ?? 0)}`
}

function promptLines(payload: PromptPayload): [DigestKind, string][] {
  const lines: [DigestKind, string][] = []
  if (payload.queued === 'removed') {
    return lines
  }
  if (payload.interrupted === true) {
    lines.push(['status', 'Interrupted the running turn'])
  }
  if (payload.auto === true) {
    const count = payload.inputs ?? 0
    lines.push(['status', `Started a turn for ${String(count)} ${count === 1 ? 'update' : 'updates'}`])
  } else if (payload.text.trim() !== '') {
    lines.push(['user', clip(payload.text, USER_CHARS)])
  }
  return lines
}

function shellLine(run: ShellResult): string {
  const command = clip(redactSecrets(run.command), TOOL_CHARS)
  if (run.ended_by !== null) {
    return `Ran in shell: ${command}. Stopped by ${run.ended_by === 'timeout' ? 'the time limit' : 'the user'}.`
  }
  const failed = run.exit_code !== 0 && run.stderr !== ''
  const output = firstLine(failed ? run.stderr : run.stdout, RESULT_CHARS)
  const status = run.exit_code === null ? 'Did not finish' : `Exit ${String(run.exit_code)}`
  return output === '' ? `Ran in shell: ${command}. ${status}.` : `Ran in shell: ${command}. ${status}: ${output}`
}

const updateLine = (input: TaskInput) =>
  clip(input.title.includes(input.subject) ? input.title : `${input.subject}: ${input.title}`, USER_CHARS)

/** How an update the agent did not get as usual is marked: dismissed, or quiet with its reason. */
function updateMark(input: TaskInput): string {
  const quiet = quietReason(input)
  if (quiet !== undefined) {
    return ` (${QUIET_LABELS[quiet]})`
  }
  return input.dismissed_at === undefined ? '' : ' (dismissed)'
}

interface Lookup {
  results: ReadonlyMap<string, ToolEnd>
  subtasks: ReadonlyMap<string, SubtaskBrief>
}

function subtaskState(subtask: SubtaskBrief): string {
  if (subtask.status === 'running') {
    const last = subtask.progress?.last_tool ?? null
    const parts = [
      'running',
      subtask.usage === null ? null : `${String(subtask.usage.tool_uses)} tool uses so far`,
      last === null ? null : `last ${toolName(last)}`,
    ]
    return parts.filter((part) => part !== null).join(', ')
  }
  if (subtask.status === 'unknown') {
    return 'no outcome recorded'
  }
  const took = subtask.ended_at === null ? 0 : Date.parse(subtask.ended_at) - Date.parse(subtask.started_at)
  const ended = took >= 1000 ? `${subtask.status} in ${duration(took)}` : subtask.status
  return subtask.summary === null ? ended : `${ended}: ${clip(subtask.summary, RESULT_CHARS)}`
}

/** One line per subagent, with what it is doing now or how it ended. */
function subtaskLine(subtask: SubtaskBrief): string {
  const kind = [subtask.subagent_type, subtask.background ? 'background' : null].filter((part) => part !== null)
  const about = kind.length === 0 ? '' : ` (${kind.join(', ')})`
  const line = `Subtask "${clip(subtask.description, TOOL_CHARS)}"${about}: ${subtaskState(subtask)}`
  return /[.!?]$/.test(line) ? line : `${line}.`
}

/** One runtime event's lines: what the agent said and ran, and how turns and compactions ended. */
function eventLines(event: RuntimeEvent, lookup: Lookup): [DigestKind, string][] {
  if (event.type === 'turn.ended') {
    return [['status', turnEnd(event)]]
  }
  if (event.type === 'compaction' && event.phase === 'done') {
    return [['status', `Compacted the conversation${compactedWithin(event.window, event.before ?? 0)}`]]
  }
  if (event.thread !== '') {
    return []
  }
  if (event.type === 'message' && event.role === 'agent' && event.text.trim() !== '') {
    return [['agent', clip(event.text, AGENT_CHARS)]]
  }
  if (event.type !== 'tool.started') {
    return []
  }
  const { call } = event
  const subtask = lookup.subtasks.get(call.callId)
  if (subtask !== undefined) {
    return [['subtask', subtaskLine(subtask)]]
  }
  return [['tool', `Ran: ${toolLabel(call)}.${outcome(call, lookup.results.get(call.callId))}`]]
}

type SetiPayload = Extract<MessageRow, { kind: 'seti' }>['payload']

const setiNoteIsError = ({
  session,
  seti_control,
  bypass,
  setting,
  timed_out,
  resumed,
  refused_host,
  edited,
}: SetiPayload) =>
  refused_host === undefined &&
  setting === undefined &&
  edited === undefined &&
  session === undefined &&
  seti_control === undefined &&
  bypass === undefined &&
  timed_out === undefined &&
  resumed !== true

function rowLines(row: MessageRow, lookup: Lookup): [DigestKind, string][] {
  switch (row.kind) {
    case 'prompt':
      return promptLines(row.payload)
    case 'sdk':
      return rowEvents(row).flatMap((event) => eventLines(event, lookup))
    case 'seti':
      return [['status', `${setiNoteIsError(row.payload) ? 'Error: ' : ''}${clip(row.payload.error, RESULT_CHARS)}`]]
    case 'shell':
      return [['shell', shellLine(row.payload)]]
    case 'input':
      return [['update', `${updateLine(row.payload)}${updateMark(row.payload)}`]]
    case 'notice':
      return [['update', row.payload.title]]
    case 'unreadable':
      return []
  }
}

/** The digest lines of each row, oldest row first, so a reader can page by row id. */
export function digestByRow(
  rows: readonly MessageRow[],
  subtasks: readonly SubtaskBrief[] = [],
): { id: number; lines: DigestLine[] }[] {
  const lookup = { results: toolEnds(rows), subtasks: new Map(subtasks.map((s) => [s.tool_use_id, s])) }
  return rows.map((row) => ({
    id: row.id,
    lines: rowLines(row, lookup).map(([kind, text]) => ({ at: row.created_at, kind, text })),
  }))
}

/** A readable, condensed transcript of task messages, oldest first; one line per subagent. */
export function buildDigest(rows: readonly MessageRow[], subtasks: readonly SubtaskBrief[] = []): DigestLine[] {
  return digestByRow(rows, subtasks).flatMap((row) => row.lines)
}
