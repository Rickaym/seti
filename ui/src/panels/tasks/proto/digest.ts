import {
  eventsOf,
  isRuntimeRow,
  rowEvents,
  type ChannelInput,
  type TaskInput,
  type TeamInput,
  type ToolCall,
  type WireRow,
} from '@seti/shared'
import { refusals } from '@/lib/tool-summary'
import {
  indexTranscript,
  resultText,
  rowCalls,
  subagentOf,
  type TranscriptIndex,
  type ToolResultRef,
} from '@/lib/transcript'

type PromptRow = Extract<WireRow, { kind: 'prompt' }>
type InputRow = Extract<WireRow, { kind: 'input' }>

/** A message a person wrote to the agent from outside Seti: team chat or a Slack-style post. */
export type PersonInput = TeamInput | ChannelInput

/** Everything the agent did between two lines of the conversation, folded into one. */
export interface WorkSpan {
  rows: WireRow[]
  calls: ToolCall[]
  results: (ToolResultRef | undefined)[]
  failed: number
  refused: number
  /** The newest finished call failed and nothing since has run: a failure still standing. */
  standing: ToolCall | null
  files: string[]
  /** Updates the agent received in this stretch; the world strip shows their current state. */
  updates: InputRow[]
  turns: number
  start: string
  end: string
  /** The call that is running now, if the agent is in this stretch. */
  live: { call: ToolCall; since: string } | null
}

export type ChatItem =
  | { type: 'user'; row: PromptRow }
  | { type: 'agent'; row: WireRow; text: string }
  | { type: 'person'; row: InputRow; input: PersonInput }
  | { type: 'ask'; row: WireRow }
  | { type: 'alert'; row: WireRow }
  | { type: 'work'; span: WorkSpan }

/** A team chat message, or a channel event a person wrote, such as a Slack thread reply. */
const personOf = (input: TaskInput): PersonInput | null => {
  if (input.source === 'team') {
    return input
  }
  return input.source === 'channel' && input.kind === 'message' ? input : null
}

const agentText = (row: WireRow): string =>
  eventsOf(rowEvents(row), 'message')
    .filter((event) => event.role === 'agent' && event.thread === '' && event.text.trim() !== '')
    .map((event) => event.text)
    .join('\n\n')

const asksQuestion = (row: WireRow) => rowCalls(row).some((call) => call.kind === 'question')

function newSpan(at: string): WorkSpan {
  return {
    rows: [],
    calls: [],
    results: [],
    failed: 0,
    refused: 0,
    standing: null,
    files: [],
    updates: [],
    turns: 0,
    start: at,
    end: at,
    live: null,
  }
}

/** Adds a row's calls, results and touched files to the stretch it belongs to. */
function collector(at: string, index: TranscriptIndex, running: boolean) {
  const span = newSpan(at)
  const addCall = (call: ToolCall, since: string) => {
    const result = index.results.get(call.callId)
    if (span.calls.length === 0) {
      span.start = since
    }
    span.end = result?.at ?? since
    span.calls.push(call)
    span.results.push(result)
    for (const change of call.edit?.changes ?? []) {
      const name = change.path.split('/').at(-1) ?? change.path
      if (!span.files.includes(name)) {
        span.files.push(name)
      }
    }
    if (result === undefined) {
      span.live = running ? { call, since } : null
      return
    }
    span.failed += result.failed ? 1 : 0
    span.refused += refusals(resultText(result)).length
    span.standing = result.failed ? call : null
  }
  const add = (row: WireRow) => {
    span.rows.push(row)
    if (row.kind === 'input') {
      span.updates.push(row)
      return
    }
    span.turns += eventsOf(rowEvents(row), 'turn.ended').length
    if (subagentOf(row) === null) {
      for (const call of rowCalls(row)) {
        addCall(call, row.created_at)
      }
    }
  }
  return { span, add }
}

/** Whether a row is a line of the conversation rather than work, and which kind. */
function conversationItem(row: WireRow): ChatItem | null {
  if (row.kind === 'prompt') {
    return row.payload.auto === true || row.payload.retry === true ? null : { type: 'user', row }
  }
  if (row.kind === 'input') {
    const input = personOf(row.payload)
    return input === null ? null : { type: 'person', row, input }
  }
  if (row.kind === 'seti' || row.kind === 'unreadable') {
    return { type: 'alert', row }
  }
  if (!isRuntimeRow(row) || subagentOf(row) !== null) {
    return null
  }
  if (asksQuestion(row)) {
    return { type: 'ask', row }
  }
  const text = agentText(row)
  return text === '' || rowCalls(row).length > 0 ? null : { type: 'agent', row, text }
}

/** The transcript as a conversation: what people and the agent said, with the work between folded. */
export function digest(rows: readonly WireRow[], running: boolean): ChatItem[] {
  const index = indexTranscript(rows)
  const items: ChatItem[] = []
  let open: ReturnType<typeof collector> | null = null
  const close = () => {
    const span = open?.span
    if (span !== undefined && (span.calls.length > 0 || span.updates.length > 0 || span.turns > 0)) {
      items.push({ type: 'work', span })
    }
    open = null
  }
  for (const row of rows) {
    const item = conversationItem(row)
    if (item === null) {
      open ??= collector(row.created_at, index, running)
      open.add(row)
      continue
    }
    close()
    items.push(item)
  }
  close()
  return items
}

/** Updates of one subject replace each other only within a strand: CI, the PR's end, its talk. */
const STRANDS: Record<string, string> = {
  ci_failed: 'ci',
  ci_passed: 'ci',
  merged: 'end',
  closed: 'end',
  conflict: 'conflict',
  review: 'talk',
  comment: 'talk',
  other: 'other',
}

/** Updates that change what the user might act on, newest state per subject, since `afterId`. */
export function worldState(rows: readonly WireRow[], afterId: number): InputRow[] {
  const latest = new Map<string, InputRow>()
  for (const row of rows) {
    if (row.id <= afterId || row.kind !== 'input' || personOf(row.payload) !== null) {
      continue
    }
    const input = row.payload
    if (input.source === 'pr' && input.quiet !== undefined) {
      continue
    }
    const key = `${input.subject} ${STRANDS[input.source === 'pr' ? input.kind : 'other'] ?? 'other'}`
    latest.delete(key)
    latest.set(key, row)
  }
  return [...latest.values()]
}

/** The id of the user's newest own message, or 0 when there is none. */
export const lastOwnMessage = (rows: readonly WireRow[]): number =>
  rows.findLast((row) => row.kind === 'prompt' && row.payload.auto !== true)?.id ?? 0
