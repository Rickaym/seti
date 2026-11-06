import type { MessageRow, TaskInput } from '@seti/shared'
import { currentRequestSource } from './access.js'
import { HttpError } from './http.js'
import { directRows } from './store/direct.js'
import { teamMembers, teamMessages, type DirectParties } from './store/team.js'

/** What a reader who is not party to a direct message sees in its place. */
export const DIRECT_HIDDEN = '[direct message hidden]'

/**
 * Who reads a transcript: the user sees everything, the EA and an agent see a direct message only
 * when they sent or got it, and nobody, as in a summary both read, sees none.
 */
export type TranscriptReader =
  | { kind: 'user' }
  | { kind: 'nobody' }
  | { kind: 'ea' }
  | { kind: 'task'; taskId: string }
  | { kind: 'mod'; modId: string }

export function transcriptReader(): TranscriptReader {
  const source = currentRequestSource()
  if (source?.via === 'ea') {
    return { kind: 'ea' }
  }
  if (source?.via === 'mod') {
    return { kind: 'mod', modId: source.modId }
  }
  return source?.via === 'agent' ? { kind: 'task', taskId: source.taskId } : { kind: 'user' }
}

const POST_TOOL = 'mcp__seti__post_team_chat'
const DIRECT_LINE = /^direct:? +@([a-z0-9][a-z0-9-]*)/im
const DIRECT_HEADING = /### \d+ [^\n]*, direct to /
/** How seti tools that read the group chat mark a direct message in what they return. */
const DIRECT_MARK = '"direct": true'
const UNKNOWN = { kind: 'handle', handle: '' } as const
/** The other party of a direct message in a row: an agent, ea, a mod, or a handle, maybe unknown. */
type Other =
  | { kind: 'task'; taskId: string | null }
  | { kind: 'ea' }
  | { kind: 'mod'; modId: string | null }
  | { kind: 'handle'; handle: string }
  | null

interface Block {
  type: string
  name?: string
  input?: unknown
  content?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const blocksOf = (row: MessageRow): Block[] => {
  if (row.kind !== 'sdk' || (row.payload.type !== 'assistant' && row.payload.type !== 'user')) {
    return []
  }
  const content: unknown = row.payload.message.content
  return Array.isArray(content) ? content.filter((block): block is Block => isRecord(block)) : []
}

const textOf = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  return Array.isArray(value) ? value.map((part) => (isRecord(part) ? textOf(part.text) : '')).join('\n') : ''
}

/** Whoever else a tool result shows a direct message of: an unknown party for chat reads. */
function resultRecipient(text: string): Other {
  if (!text.includes('"to_kind"')) {
    return DIRECT_HEADING.test(text) || text.includes(DIRECT_MARK) ? UNKNOWN : null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const message = isRecord(parsed) && isRecord(parsed.message) ? parsed.message : null
    if (message?.to_kind === 'ea') {
      return { kind: 'ea' }
    }
    return message?.to_kind === 'task' ? { kind: 'task', taskId: textOrNull(message.to_task_id) } : null
  } catch {
    return UNKNOWN
  }
}

const textOrNull = (value: unknown) => (typeof value === 'string' ? value : null)

/** The other party of a block that sends or reads a direct message, or null for any other block. */
function blockOther(block: Block): Other {
  if (block.type === 'tool_result') {
    return resultRecipient(textOf(block.content))
  }
  if (block.type !== 'tool_use' || !isRecord(block.input)) {
    return null
  }
  const to = typeof block.input.to === 'string' ? block.input.to.trim().replace(/^@/, '').toLowerCase() : ''
  if (block.name === POST_TOOL && to !== '') {
    return to === 'ea' ? { kind: 'ea' } : { kind: 'handle', handle: to }
  }
  const handle = DIRECT_LINE.exec(Object.values(block.input).map(textOf).join('\n'))?.[1]?.toLowerCase()
  if (handle === undefined || !JSON.stringify(block.input).includes('chat.md')) {
    return null
  }
  return handle === 'ea' ? { kind: 'ea' } : { kind: 'handle', handle }
}

const directInput = (row: MessageRow): (TaskInput & { source: 'team'; message_id: number }) | null =>
  row.kind === 'input' && row.payload.source === 'team' && row.payload.kind === 'direct' ? row.payload : null

/** Hides what a direct message said: its text and every string in the tool calls carrying it. */
function hidden(row: MessageRow): MessageRow {
  if (row.kind === 'input') {
    return { ...row, payload: { ...row.payload, title: DIRECT_HIDDEN, body: DIRECT_HIDDEN } }
  }
  if (row.kind !== 'sdk' || (row.payload.type !== 'assistant' && row.payload.type !== 'user')) {
    return row
  }
  const blocks = blocksOf(row).map((block) => {
    if (blockOther(block) === null) {
      return block
    }
    if (block.type === 'tool_result') {
      return { ...block, content: DIRECT_HIDDEN }
    }
    const input = isRecord(block.input) ? block.input : {}
    return { ...block, input: Object.fromEntries(Object.keys(input).map((key) => [key, hideField(key, input[key])])) }
  })
  const message = { ...row.payload.message, content: blocks } as typeof row.payload.message
  return { ...row, payload: { ...row.payload, message } } as MessageRow
}

const KEPT_FIELDS = new Set(['to', 'file_path'])
const hideField = (key: string, value: unknown) => (KEPT_FIELDS.has(key) ? value : DIRECT_HIDDEN)

type Marked = { kind: 'input'; id: number } | { kind: 'block'; other: Exclude<Other, null> } | null

function markOf(row: MessageRow): Marked {
  const input = directInput(row)
  if (input !== null) {
    return { kind: 'input', id: input.message_id }
  }
  const other =
    blocksOf(row)
      .map(blockOther)
      .find((found) => found !== null) ?? null
  return other === null ? null : { kind: 'block', other }
}

async function readerHandle(reader: TranscriptReader): Promise<string | null> {
  return reader.kind === 'task' ? ((await teamMembers.get(reader.taskId))?.handle ?? null) : null
}

function sees(reader: TranscriptReader, other: Exclude<Other, null>, handle: string | null): boolean {
  switch (other.kind) {
    case 'ea':
      return reader.kind === 'ea'
    case 'task':
      return reader.kind === 'task' && other.taskId === reader.taskId
    case 'mod':
      return reader.kind === 'mod' && other.modId === reader.modId
    case 'handle':
      return handle !== null && other.handle === handle
  }
}

function authorOf(parties: DirectParties): Exclude<Other, null> {
  if (parties.author_kind === 'ea') {
    return { kind: 'ea' }
  }
  return parties.author_kind === 'mod'
    ? { kind: 'mod', modId: parties.author_mod_id ?? null }
    : { kind: 'task', taskId: parties.author_task_id }
}

/** The other party of each direct message delivered in these rows: the one who sent it. */
async function inputOthers(rows: readonly MessageRow[]): Promise<Map<number, Exclude<Other, null>>> {
  const ids = rows.flatMap((row) => {
    const input = directInput(row)
    return input === null ? [] : [input.message_id]
  })
  const others = new Map<number, Exclude<Other, null>>()
  for (const [id, parties] of await teamMessages.parties(ids)) {
    others.set(id, authorOf(parties))
  }
  return others
}

/**
 * The rows of one task's transcript as the reader may see them: the user and the task itself
 * see them all; anyone else sees `[direct message hidden]` for a direct message it is not party
 * to.
 */
export async function hideDirect(
  taskId: string,
  rows: readonly MessageRow[],
  reader: TranscriptReader = transcriptReader(),
): Promise<MessageRow[]> {
  if (reader.kind === 'user' || (reader.kind === 'task' && reader.taskId === taskId)) {
    return [...rows]
  }
  const marked = rows.map((row) => ({ row, mark: markOf(row) }))
  if (marked.every(({ mark }) => mark === null)) {
    return [...rows]
  }
  const [inputs, handle] = await Promise.all([inputOthers(rows), readerHandle(reader)])
  return marked.map(({ row, mark }) => {
    if (mark === null) {
      return row
    }
    const party = mark.kind === 'input' ? inputs.get(mark.id) : mark.other
    return party !== undefined && sees(reader, party, handle) ? row : hidden(row)
  })
}

/** Refuses a side question to an agent whose session holds direct messages the reader may not see. */
export async function refuseHiddenDirect(taskId: string, reader: TranscriptReader = transcriptReader()): Promise<void> {
  if (reader.kind === 'user' || (reader.kind === 'task' && reader.taskId === taskId)) {
    return
  }
  const rows = await directRows.candidates(taskId)
  if ((await hiddenIds(taskId, rows, reader)).size > 0) {
    throw new HttpError(403, 'That agent holds direct messages you are not part of; ask the user to ask it')
  }
}

/** The ids of rows the reader may not read, for a search that must not match them. */
export async function hiddenIds(
  taskId: string,
  rows: readonly MessageRow[],
  reader: TranscriptReader = transcriptReader(),
): Promise<Set<number>> {
  const shown = await hideDirect(taskId, rows, reader)
  return new Set(shown.filter((row, index) => row !== rows[index]).map((row) => row.id))
}
