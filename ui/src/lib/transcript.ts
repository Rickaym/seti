import type { SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { SHELL_CONTEXT_RUNS, type MessageRow } from '@seti/shared'
import { compactFailure } from '@/lib/compacting'

type AssistantBlock = SDKAssistantMessage['message']['content'][number]
export type ToolUseBlock = Extract<AssistantBlock, { type: 'tool_use' }>
type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type ToolResultBlock = Extract<UserBlock, { type: 'tool_result' }>

/** A tool result and the stored message it came from, which holds it in full. */
export interface ToolResultRef {
  block: ToolResultBlock
  rowId: number
  /** When the result arrived, which ends the call's duration. */
  at: string
  trimmed: boolean
}

/** Where a background process a call started stands, as the session last reported it. */
export type BackgroundStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'killed'

export interface TranscriptIndex {
  results: ReadonlyMap<string, ToolResultRef>
  calls: ReadonlySet<string>
  hiddenInits: ReadonlySet<number>
  /** Background processes by the call that started them, such as a Monitor's watch. */
  background: ReadonlyMap<string, BackgroundStatus>
}

/** A string field of a tool input, if present. */
export function inputString(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

const NO_RESULTS: readonly ToolResultRef[] = []
const NO_CALLS: readonly ToolUseBlock[] = []
const resultCache = new WeakMap<MessageRow, readonly ToolResultRef[]>()
const callCache = new WeakMap<MessageRow, readonly ToolUseBlock[]>()

const isToolUse = (block: AssistantBlock): block is ToolUseBlock => block.type === 'tool_use'

/** Reads a row's blocks; a malformed row reads as none, so it cannot break the rows around it. */
function tolerant<T>(read: () => readonly T[], none: readonly T[]): readonly T[] {
  try {
    return read()
  } catch {
    return none
  }
}

/** Tool results in a row, cached per row object so memoized rows get stable references. */
export function rowResults(row: MessageRow): readonly ToolResultRef[] {
  if (row.kind !== 'sdk' || row.payload.type !== 'user' || typeof row.payload.message.content === 'string') {
    return NO_RESULTS
  }
  const cached = resultCache.get(row)
  if (cached) {
    return cached
  }
  const trimmed = new Set(row.trimmed)
  const { content } = row.payload.message
  const refs = tolerant(
    () =>
      content.flatMap((block) =>
        block.type === 'tool_result'
          ? [{ block, rowId: row.id, at: row.created_at, trimmed: trimmed.has(block.tool_use_id) }]
          : [],
      ),
    NO_RESULTS,
  )
  resultCache.set(row, refs)
  return refs
}

export function rowCalls(row: MessageRow): readonly ToolUseBlock[] {
  if (row.kind !== 'sdk' || row.payload.type !== 'assistant') {
    return NO_CALLS
  }
  const cached = callCache.get(row)
  if (cached) {
    return cached
  }
  const { message } = row.payload
  const calls = tolerant(() => message.content.filter(isToolUse), NO_CALLS)
  callCache.set(row, calls)
  return calls
}

const PATCH_STATUS: Partial<Record<string, BackgroundStatus>> = {
  pending: 'running',
  paused: 'running',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
}

/** Follows task_started, task_updated and task_notification to each process's latest status. */
function trackBackground(row: MessageRow, owners: Map<string, string>, background: Map<string, BackgroundStatus>) {
  if (row.kind !== 'sdk' || row.payload.type !== 'system') {
    return
  }
  const { payload } = row
  if (payload.subtype === 'task_started' && payload.tool_use_id !== undefined) {
    owners.set(payload.task_id, payload.tool_use_id)
    background.set(payload.tool_use_id, 'running')
  } else if (payload.subtype === 'task_notification' && payload.tool_use_id !== undefined) {
    background.set(payload.tool_use_id, payload.status)
  } else if (payload.subtype === 'task_updated') {
    const owner = owners.get(payload.task_id)
    const status = PATCH_STATUS[payload.patch.status ?? '']
    if (owner !== undefined && status !== undefined) {
      background.set(owner, status)
    }
  }
}

export function indexTranscript(rows: readonly MessageRow[]): TranscriptIndex {
  const results = new Map<string, ToolResultRef>()
  const calls = new Set<string>()
  const hiddenInits = new Set<number>()
  const owners = new Map<string, string>()
  const background = new Map<string, BackgroundStatus>()
  let session: string | null = null
  for (const row of rows) {
    trackBackground(row, owners, background)
    for (const ref of rowResults(row)) {
      results.set(ref.block.tool_use_id, ref)
    }
    for (const call of rowCalls(row)) {
      calls.add(call.id)
    }
    if (row.kind === 'sdk' && row.payload.type === 'system' && row.payload.subtype === 'init') {
      if (row.payload.session_id === session) {
        hiddenInits.add(row.id)
      }
      session = row.payload.session_id
    }
  }
  return { results, calls, hiddenInits, background }
}

const LOCAL_OUTPUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/

/** What a slash command that runs without the model printed, or null for other user messages. */
export function localCommandOutput(message: SDKUserMessage): string | null {
  const { content } = message.message
  const text = typeof content === 'string' ? content : content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  const match = LOCAL_OUTPUT.exec(text.trim())
  return match ? (match[1] ?? '').trim() : null
}

/** Whether a row shows up in the transcript, so counts of new messages skip bookkeeping rows. */
export function rendersContent(row: MessageRow): boolean {
  try {
    return shows(row)
  } catch {
    return true
  }
}

/** A turn Claude Code ran for a background notice without a step, as a resumed session does. */
const emptyNoticeTurn = (result: SDKResultMessage) =>
  result.origin?.kind === 'task-notification' && result.num_turns === 0 && !result.is_error

function shows(row: MessageRow): boolean {
  if (row.kind !== 'sdk') {
    return true
  }
  const { payload } = row
  if (payload.type === 'assistant') {
    return payload.message.content.some(
      (block) => block.type === 'tool_use' || (block.type === 'text' && block.text.trim() !== ''),
    )
  }
  if (payload.type === 'user') {
    return localCommandOutput(payload) !== null
  }
  return (
    (payload.type === 'result' && !emptyNoticeTurn(payload)) ||
    (payload.type === 'system' && payload.subtype === 'compact_boundary') ||
    (payload.type === 'system' && payload.subtype === 'model_refusal_fallback') ||
    compactFailure(row) !== null
  )
}

/** The Agent call a subagent's message belongs to, or null for the task agent's own messages. */
export function subagentOf(row: MessageRow): string | null {
  if (row.kind !== 'sdk' || (row.payload.type !== 'assistant' && row.payload.type !== 'user')) {
    return null
  }
  return row.payload.parent_tool_use_id
}

/** The Agent call of the subagent a PR update was routed to on behalf of, if any. */
export const routedSubagentOf = (row: MessageRow): string | null =>
  row.kind === 'input' && row.payload.source === 'pr' ? (row.payload.subtask?.tool_use_id ?? null) : null

/** New rows shown since `afterId`; subagent rows count only in a subtask's own transcript. */
export function countNewer(rows: readonly MessageRow[], afterId: number, subagentRows: boolean): number {
  let count = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row === undefined || row.id <= afterId) {
      break
    }
    if (rendersContent(row) && (subagentRows || subagentOf(row) === null)) {
      count++
    }
  }
  return count
}

/** Merges rows by ascending id, keeping existing row objects, and `rows` itself when unchanged. */
export function mergeRows(rows: readonly MessageRow[], incoming: readonly MessageRow[]): readonly MessageRow[] {
  const first = rows[0]
  const last = rows.at(-1)
  const incomingFirst = incoming[0]
  const incomingLast = incoming.at(-1)
  if (incomingFirst === undefined || incomingLast === undefined) {
    return rows
  }
  if (first === undefined || last === undefined) {
    return incoming
  }
  if (incomingFirst.id > last.id) {
    return [...rows, ...incoming]
  }
  if (incomingLast.id < first.id) {
    return [...incoming, ...rows]
  }
  const byId = new Map(rows.map((row) => [row.id, row]))
  const added = incoming.filter((row) => !byId.has(row.id))
  if (added.length === 0) {
    return rows
  }
  return [...rows, ...added].sort((a, b) => a.id - b.id)
}

/** Swaps in a newer copy of a loaded row; rows that are not loaded stay out. */
export function replaceRow(rows: readonly MessageRow[], row: MessageRow): readonly MessageRow[] {
  const index = rows.findIndex((loaded) => loaded.id === row.id)
  return index < 0 ? rows : rows.with(index, row)
}

export function resultText(content: ToolResultBlock['content']): string {
  if (content === undefined) {
    return ''
  }
  if (typeof content === 'string') {
    return content
  }
  return content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
}

export const fullResultText = (row: MessageRow, toolUseId: string) =>
  resultText(rowResults(row).find((ref) => ref.block.tool_use_id === toolUseId)?.block.content)

export const fullInputText = (row: MessageRow, toolUseId: string) =>
  JSON.stringify(rowCalls(row).find((call) => call.id === toolUseId)?.input, null, 2)

export const fullCommandText = (row: MessageRow, toolUseId: string) =>
  inputString(rowCalls(row).find((call) => call.id === toolUseId)?.input, 'command') ?? ''

/** A prompt the agent reads with what waited for it: not a slash command, not taken back. */
const readsPending = (row: MessageRow) =>
  row.kind === 'prompt' && !row.payload.text.startsWith('/') && row.payload.queued !== 'removed'

/** Undismissed updates the agent has not read: input rows after the last prompt it read. */
export function queuedInputs(rows: readonly MessageRow[]): Extract<MessageRow, { kind: 'input' }>[] {
  let queued: Extract<MessageRow, { kind: 'input' }>[] = []
  for (const row of rows) {
    if (readsPending(row)) {
      queued = []
    } else if (row.kind === 'input' && row.payload.dismissed_at === undefined) {
      queued.push(row)
    }
  }
  return queued
}

export const queuedInputIds = (rows: readonly MessageRow[]): Set<number> =>
  new Set(queuedInputs(rows).map((row) => row.id))

/** Whether a `!` run goes with the next message, or waits past the newest few that do. */
export type ShellDelivery = 'next' | 'dropped'

/** Shell runs since the last prompt the agent read, as `shellRuns.sinceLastTurn` picks them. */
export function shellDeliveries(rows: readonly MessageRow[]): Map<number, ShellDelivery> {
  let pending: number[] = []
  for (const row of rows) {
    if (readsPending(row)) {
      pending = []
    } else if (row.kind === 'shell') {
      pending.push(row.id)
    }
  }
  const sent = pending.length - SHELL_CONTEXT_RUNS
  return new Map(pending.map((id, index) => [id, index < sent ? 'dropped' : 'next']))
}

const applyBlock = (tail: readonly string[], block: AssistantBlock): readonly string[] => {
  if (block.type === 'tool_use') {
    return []
  }
  return block.type === 'text' && block.text.trim() !== '' ? [...tail, block.text] : tail
}

/** The texts the task agent wrote since its last tool call, with this row's blocks applied. */
function replyTail(row: MessageRow, tail: readonly string[]): readonly string[] {
  if (row.kind !== 'sdk' || row.payload.type !== 'assistant' || row.payload.parent_tool_use_id !== null) {
    return tail
  }
  const { message } = row.payload
  return tolerant(() => message.content.reduce(applyBlock, tail), tail)
}

/** Each turn's reply by its result row: the Markdown of its text blocks after the last tool call. */
export function turnReplies(rows: readonly MessageRow[]): Map<number, string> {
  const replies = new Map<number, string>()
  let tail: readonly string[] = []
  for (const row of rows) {
    if (row.kind === 'prompt') {
      tail = []
    } else if (row.kind === 'sdk' && row.payload.type === 'result') {
      if (tail.length > 0) {
        replies.set(row.id, tail.join('\n\n'))
      }
      tail = []
    } else {
      tail = replyTail(row, tail)
    }
  }
  return replies
}
