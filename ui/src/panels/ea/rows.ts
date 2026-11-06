import type { SDKAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EaChatEvent, EaHistoryEntry, EaNotice, MessageRow } from '@seti/shared'
import type { ToolUseBlock } from '@/lib/transcript'
import type { TranscriptMarks, TranscriptNote } from '@/panels/tasks/TranscriptMarks'

/** One step of the reply that is still streaming: text as written, or a tool call. */
type LivePart =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      arguments: Record<string, unknown>
      result: { summary: string; ok: boolean; text: string } | null
    }

/** The typed message whose reply is on screen before the stored history has it. */
export interface LiveExchange {
  text: string
  at: string
  parts: LivePart[]
  /** The stored entries of this exchange once the EA is done with it. */
  stored?: number[]
}

export interface ChatView {
  rows: MessageRow[]
  marks: TranscriptMarks
}

const CALL_STARTED = 'Call started'
export const SUMMARISED = 'Earlier conversation summarised'
export const EA_TASK_ID = 'ea'

const SUMMARY_PREFIX = /^Summary of the earlier conversation with the user:\s*/
const LIVE_BASE = Number.MAX_SAFE_INTEGER - 10_000

type AssistantBlock = SDKAssistantMessage['message']['content'][number]
type ToolResultBlock = Extract<Exclude<SDKUserMessage['message']['content'], string>[number], { type: 'tool_result' }>

const asAssistant = (value: object) => value as SDKAssistantMessage
const asUser = (value: object) => value as SDKUserMessage

const base = (id: number, at: string) => ({ id, task_id: EA_TASK_ID, outward: [], created_at: at })

const promptRow = (id: number, at: string, text: string): MessageRow => ({
  ...base(id, at),
  kind: 'prompt',
  payload: { text },
})

const assistantRow = (id: number, at: string, content: AssistantBlock[]): MessageRow => ({
  ...base(id, at),
  kind: 'sdk',
  payload: asAssistant({
    type: 'assistant',
    message: { role: 'assistant', content },
    parent_tool_use_id: null,
    session_id: EA_TASK_ID,
    uuid: `ea-${String(id)}`,
  }),
})

const resultRow = (id: number, at: string, results: ToolResultBlock[]): MessageRow => ({
  ...base(id, at),
  kind: 'sdk',
  payload: asUser({
    type: 'user',
    message: { role: 'user', content: results },
    parent_tool_use_id: null,
    session_id: EA_TASK_ID,
  }),
})

const INBOX_PREFIX = /^Inbox:\s*/

/** An inbox entry's notice; one without it, as after its item was deleted, shows its text. */
function noticeOf(entry: EaHistoryEntry): EaNotice {
  const text = entry.message.content ?? ''
  return (
    entry.notice ?? {
      kind: 'watch_event',
      event: 'note',
      title: text.replace(INBOX_PREFIX, ''),
      body: '',
      url: null,
      severity: 'info',
      source: 'EA',
    }
  )
}

const noticeRow = (entry: EaHistoryEntry): MessageRow => ({
  ...base(entry.id, entry.created_at),
  kind: 'notice',
  payload: noticeOf(entry),
})

const textBlock = (text: string): AssistantBlock => ({ type: 'text', text, citations: null })

const toolUse = (id: string, name: string, input: unknown): ToolUseBlock => ({ type: 'tool_use', id, name, input })

/** Tool arguments as the model wrote them, or the raw text when they are not JSON. */
function parsedArguments(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** Tool results are stored as JSON; most are one quoted string. */
function resultText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content)
    return typeof parsed === 'string' ? parsed : content
  } catch {
    return content
  }
}

const clock = (at: string) =>
  new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function entryRow(entry: EaHistoryEntry): MessageRow | null {
  const { id, created_at: at, message } = entry
  switch (message.role) {
    case 'user':
      return promptRow(id, at, message.content)
    case 'assistant': {
      const text = message.content ?? ''
      const calls = (message.tool_calls ?? []).map((call) =>
        toolUse(call.id, call.function.name, parsedArguments(call.function.arguments)),
      )
      const blocks = [...(text.trim() === '' ? [] : [textBlock(text)]), ...calls]
      return blocks.length === 0 ? null : assistantRow(id, at, blocks)
    }
    case 'tool':
      return resultRow(id, at, [
        { type: 'tool_result', tool_use_id: message.tool_call_id, content: resultText(message.content) },
      ])
    case 'developer':
      return null
  }
}

function rowOf(entry: EaHistoryEntry): MessageRow | null {
  if (entry.kind === 'summary') {
    return null
  }
  return entry.kind === 'inbox' ? noticeRow(entry) : entryRow(entry)
}

/** Where each summary goes: before the first entry after the ones it stands in for. */
function summaryNotes(entries: readonly EaHistoryEntry[]): Map<number, TranscriptNote> {
  const notes = new Map<number, TranscriptNote>()
  const rest = entries.filter((entry) => entry.kind !== 'summary')
  for (const entry of entries) {
    if (entry.kind !== 'summary') {
      continue
    }
    const next = rest.find((other) => other.id > (entry.through_id ?? 0)) ?? rest[0]
    if (next !== undefined) {
      const detail = entry.message.content?.replace(SUMMARY_PREFIX, '') ?? ''
      notes.set(next.id, { text: SUMMARISED, detail })
    }
  }
  return notes
}

function exchangeRows(live: LiveExchange): MessageRow[] {
  const rows: MessageRow[] = [promptRow(LIVE_BASE, live.at, live.text)]
  let text = ''
  const flush = () => {
    if (text !== '') {
      rows.push(assistantRow(LIVE_BASE + rows.length, live.at, [textBlock(text)]))
      text = ''
    }
  }
  for (const part of live.parts) {
    if (part.kind === 'text') {
      text += part.text
      continue
    }
    flush()
    rows.push(assistantRow(LIVE_BASE + rows.length, live.at, [toolUse(part.id, part.name, part.arguments)]))
    if (part.result !== null) {
      const { text: output, ok } = part.result
      const block: ToolResultBlock = { type: 'tool_result', tool_use_id: part.id, content: output, is_error: !ok }
      rows.push(resultRow(LIVE_BASE + rows.length, live.at, [block]))
    }
  }
  flush()
  return rows
}

/** Whether the stored history already shows the exchange, so its live copy can go. */
function landed(entries: readonly EaHistoryEntry[], live: LiveExchange): boolean {
  const last = live.stored?.at(-1)
  return last !== undefined && entries.some((entry) => entry.id === last)
}

/** The reply in flight as task transcript rows, or none once the stored history shows it. */
export function liveRows(entries: readonly EaHistoryEntry[], live: LiveExchange | null): MessageRow[] {
  return live === null || landed(entries, live) ? [] : exchangeRows(live)
}

/** The stored conversation as task transcript rows, with spoken turns and dividers marked. */
export function chatView(entries: readonly EaHistoryEntry[]): ChatView {
  const rows: MessageRow[] = []
  const voice = new Set<number>()
  const notes = summaryNotes(entries)
  let callAt: string | null = null
  for (const entry of entries) {
    if (entry.kind === 'call') {
      callAt = entry.created_at
      continue
    }
    const row = rowOf(entry)
    if (row === null) {
      continue
    }
    if (callAt !== null) {
      notes.set(row.id, { text: `${CALL_STARTED} ${clock(callAt)}` })
      callAt = null
    }
    if (entry.kind === 'message') {
      voice.add(row.id)
    }
    rows.push(row)
  }
  return { rows, marks: { voice, notes } }
}

export function applyEvent(live: LiveExchange, event: EaChatEvent): LiveExchange {
  switch (event.type) {
    case 'text': {
      const last = live.parts.at(-1)
      if (last?.kind === 'text') {
        return { ...live, parts: [...live.parts.slice(0, -1), { kind: 'text', text: last.text + event.delta }] }
      }
      return { ...live, parts: [...live.parts, { kind: 'text', text: event.delta }] }
    }
    case 'tool': {
      const part: LivePart = { kind: 'tool', id: event.id, name: event.name, arguments: event.arguments, result: null }
      return { ...live, parts: [...live.parts, part] }
    }
    case 'tool_result': {
      const result = { summary: event.summary, ok: event.ok, text: event.text }
      if (!live.parts.some((part) => part.kind === 'tool' && part.id === event.id)) {
        const part: LivePart = { kind: 'tool', id: event.id, name: event.name, arguments: {}, result }
        return { ...live, parts: [...live.parts, part] }
      }
      const parts = live.parts.map((part) =>
        part.kind === 'tool' && part.id === event.id ? { ...part, result } : part,
      )
      return { ...live, parts }
    }
    case 'done':
      return { ...live, stored: event.ids }
    case 'error':
      return live
  }
}

/** The last thing the EA wrote, when nothing follows it. */
export function lastReply(entries: readonly EaHistoryEntry[]): string | null {
  const last = entries.findLast((entry) => entry.kind !== 'summary' && entry.message.role !== 'developer')
  if (last?.message.role !== 'assistant') {
    return null
  }
  return last.message.content ?? null
}
