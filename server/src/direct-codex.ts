import type { MessageRow } from '@seti/shared'

/** What a reader who is not party to a direct message sees in its place. */
export const DIRECT_HIDDEN = '[direct message hidden]'

/** A tool call or its result, as the direct message check reads it in any runtime's row. */
export interface Block {
  type: string
  name?: string
  input?: unknown
  content?: unknown
}

type CodexRow = Extract<MessageRow, { kind: 'sdk'; runtime: 'codex' }>
type Fields = Record<string, unknown>

const isRecord = (value: unknown): value is Fields => typeof value === 'object' && value !== null

const isCodexRow = (row: MessageRow): row is CodexRow => row.kind === 'sdk' && row.runtime === 'codex'

/** The notification a Codex row stores: its method and params. */
function noteOf(row: MessageRow): { method: string; params: Fields } | null {
  if (!isCodexRow(row) || !isRecord(row.payload.message)) {
    return null
  }
  const { method, params } = row.payload.message
  return typeof method === 'string' && isRecord(params) ? { method, params } : null
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The lines a diff adds, without their marker, as the text the edit writes. */
const added = (diff: unknown): string =>
  text(diff)
    .split('\n')
    .flatMap((line) => (line.startsWith('+') && !line.startsWith('+++') ? [line.slice(1)] : []))
    .join('\n')

const changesOf = (item: Fields): Fields[] => (Array.isArray(item.changes) ? item.changes.filter(isRecord) : [])

/** The call a Codex item makes, as a tool use, and what it answered, as a tool result. */
function itemBlocks(item: Fields): Block[] {
  switch (item.type) {
    case 'mcpToolCall': {
      const use = { type: 'tool_use', name: `mcp__${text(item.server)}__${text(item.tool)}`, input: item.arguments }
      return isRecord(item.result) ? [use, { type: 'tool_result', content: item.result.content }] : [use]
    }
    case 'commandExecution': {
      const use = { type: 'tool_use', name: 'Bash', input: { command: item.command } }
      return typeof item.aggregatedOutput === 'string'
        ? [use, { type: 'tool_result', content: item.aggregatedOutput }]
        : [use]
    }
    case 'fileChange':
      return changesOf(item).map((change) => ({
        type: 'tool_use',
        name: 'Edit',
        input: { file_path: change.path, diff: added(change.diff) },
      }))
    default:
      return []
  }
}

/** The tool uses and results a Codex row carries; none for any other row. */
export function codexBlocks(row: MessageRow): Block[] {
  const note = noteOf(row)
  if (note === null) {
    return []
  }
  if (note.method.endsWith('/outputDelta')) {
    return [{ type: 'tool_result', content: note.params.delta }]
  }
  return isRecord(note.params.item) ? itemBlocks(note.params.item) : []
}

/** How a hidden row is made: which blocks carry a direct message, and what a field becomes. */
export interface Hiding {
  marked: (block: Block) => boolean
  field: (key: string, value: unknown) => unknown
}

const HIDDEN_RESULT = { content: [{ type: 'text', text: DIRECT_HIDDEN }] }

/** The item with the parts that carry a direct message hidden. */
function hiddenItem(item: Fields, hiding: Hiding): Fields {
  const [use, result] = itemBlocks(item)
  const call = use !== undefined && hiding.marked(use)
  const answer = result !== undefined && hiding.marked(result)
  switch (item.type) {
    case 'mcpToolCall': {
      const args = isRecord(item.arguments) ? item.arguments : {}
      const hiddenArgs = Object.fromEntries(Object.keys(args).map((key) => [key, hiding.field(key, args[key])]))
      return { ...item, ...(call ? { arguments: hiddenArgs } : {}), ...(answer ? { result: HIDDEN_RESULT } : {}) }
    }
    case 'commandExecution':
      return {
        ...item,
        ...(call ? { command: DIRECT_HIDDEN, commandActions: [] } : {}),
        ...(answer ? { aggregatedOutput: DIRECT_HIDDEN } : {}),
      }
    case 'fileChange': {
      const blocks = itemBlocks(item)
      const changes = changesOf(item).map((change, index) => {
        const block = blocks[index]
        return block !== undefined && hiding.marked(block) ? { ...change, diff: DIRECT_HIDDEN } : change
      })
      return { ...item, changes }
    }
    default:
      return item
  }
}

/** A Codex row with every part that carries a direct message hidden; any other row unchanged. */
export function codexHidden(row: MessageRow, hiding: Hiding): MessageRow {
  const note = noteOf(row)
  if (note === null || !isCodexRow(row)) {
    return row
  }
  const { params } = note
  let hidden: Fields = params
  if (note.method.endsWith('/outputDelta')) {
    hidden = { ...params, delta: DIRECT_HIDDEN }
  } else if (isRecord(params.item)) {
    hidden = { ...params, item: hiddenItem(params.item, hiding) }
  }
  const message = { ...note, params: hidden }
  return { ...row, payload: { ...row.payload, message } }
}
