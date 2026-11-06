import type { SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  compactedAt,
  type DigestKind,
  type DigestLine,
  type MessageRow,
  type PromptPayload,
  type ShellResult,
  type SubtaskBrief,
  type TaskInput,
} from '@seti/shared'
import { bashCommand } from './outward.js'
import { redactCredentials, redactSecrets } from './scrub.js'

const USER_CHARS = 600
const AGENT_CHARS = 1200
const TOOL_CHARS = 160
const RESULT_CHARS = 160

type AssistantBlock = SDKAssistantMessage['message']['content'][number]
type ToolUseBlock = Extract<AssistantBlock, { type: 'tool_use' }>
type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type ToolResultBlock = Extract<UserBlock, { type: 'tool_result' }>

/** Tools whose successful output is file content or matches, which reads as noise. */
const QUIET_RESULTS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead'])

/** Input fields that name what a non-Bash tool worked on, in order of preference. */
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
export function toolLabel(block: ToolUseBlock): string {
  if (block.name === 'Bash') {
    const command = bashCommand(block.input)
    return clip(command === '' ? 'Bash' : redactSecrets(command), TOOL_CHARS)
  }
  const target = TARGET_FIELDS.map((key) => field(block.input, key)).find((value) => value !== null)
  return clip(target === undefined ? toolName(block.name) : `${toolName(block.name)} ${target}`, TOOL_CHARS)
}

function resultText(block: ToolResultBlock): string {
  const { content } = block
  if (content === undefined) {
    return ''
  }
  if (typeof content === 'string') {
    return content
  }
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
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

function outcome(call: ToolUseBlock, result: ToolResultBlock | undefined): string {
  if (result === undefined) {
    return ''
  }
  const text = firstLine(resultText(result), RESULT_CHARS)
  if (result.is_error === true) {
    return text === '' ? ' Failed.' : ` Failed: ${text}`
  }
  return text === '' || QUIET_RESULTS.has(call.name) ? '' : ` Result: ${text}`
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
}

const RESULT_ENDINGS: Partial<Record<string, string>> = {
  error_during_execution: 'Turn ended with an error',
  error_max_turns: 'Turn stopped at the turn limit',
  error_max_budget_usd: 'Turn stopped at the budget limit',
  error_max_structured_output_retries: 'Turn stopped after too many output retries',
}

function turnEnd(m: SDKResultMessage): string {
  if (m.subtype !== 'success') {
    return RESULT_ENDINGS[m.subtype] ?? 'Turn ended'
  }
  return m.is_error ? `Turn failed: ${clip(m.result, RESULT_CHARS)}` : `Turn finished in ${duration(m.duration_ms)}`
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

interface Lookup {
  results: ReadonlyMap<string, ToolResultBlock>
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

function assistantLines(m: SDKAssistantMessage, lookup: Lookup): [DigestKind, string][] {
  return m.message.content.flatMap((block): [DigestKind, string][] => {
    if (block.type === 'text' && block.text.trim() !== '') {
      return [['agent', clip(block.text, AGENT_CHARS)]]
    }
    if (block.type !== 'tool_use') {
      return []
    }
    const subtask = lookup.subtasks.get(block.id)
    if (subtask !== undefined) {
      return [['subtask', subtaskLine(subtask)]]
    }
    return [['tool', `Ran: ${toolLabel(block)}.${outcome(block, lookup.results.get(block.id))}`]]
  })
}

function sdkLines(m: SDKMessage, lookup: Lookup): [DigestKind, string][] {
  if (m.type === 'assistant') {
    return m.parent_tool_use_id === null ? assistantLines(m, lookup) : []
  }
  if (m.type === 'result') {
    return [['status', turnEnd(m)]]
  }
  if (m.type === 'system' && m.subtype === 'compact_boundary') {
    return [['status', `Compacted the conversation${compactedAt(m, m.compact_metadata.pre_tokens)}`]]
  }
  return []
}

const setiNoteIsError = ({ session, seti_control, bypass }: Extract<MessageRow, { kind: 'seti' }>['payload']) =>
  session === undefined && seti_control === undefined && bypass === undefined

function rowLines(row: MessageRow, lookup: Lookup): [DigestKind, string][] {
  switch (row.kind) {
    case 'prompt':
      return promptLines(row.payload)
    case 'sdk':
      return sdkLines(row.payload, lookup)
    case 'seti':
      return [['status', `${setiNoteIsError(row.payload) ? 'Error: ' : ''}${clip(row.payload.error, RESULT_CHARS)}`]]
    case 'shell':
      return [['shell', shellLine(row.payload)]]
    case 'input':
      return [['update', `${updateLine(row.payload)}${row.payload.dismissed_at === undefined ? '' : ' (dismissed)'}`]]
    case 'notice':
      return [['update', row.payload.title]]
    case 'unreadable':
      return []
  }
}

function toolResults(rows: readonly MessageRow[]): Map<string, ToolResultBlock> {
  const results = new Map<string, ToolResultBlock>()
  for (const row of rows) {
    if (row.kind !== 'sdk' || row.payload.type !== 'user' || typeof row.payload.message.content === 'string') {
      continue
    }
    for (const block of row.payload.message.content) {
      if (block.type === 'tool_result') {
        results.set(block.tool_use_id, block)
      }
    }
  }
  return results
}

/** The digest lines of each row, oldest row first, so a reader can page by row id. */
export function digestByRow(
  rows: readonly MessageRow[],
  subtasks: readonly SubtaskBrief[] = [],
): { id: number; lines: DigestLine[] }[] {
  const lookup = { results: toolResults(rows), subtasks: new Map(subtasks.map((s) => [s.tool_use_id, s])) }
  return rows.map((row) => ({
    id: row.id,
    lines: rowLines(row, lookup).map(([kind, text]) => ({ at: row.created_at, kind, text })),
  }))
}

/** A readable, condensed transcript of task messages, oldest first; one line per subagent. */
export function buildDigest(rows: readonly MessageRow[], subtasks: readonly SubtaskBrief[] = []): DigestLine[] {
  return digestByRow(rows, subtasks).flatMap((row) => row.lines)
}
