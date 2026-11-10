import type { MessageRow, TaskRewind } from '@seti/shared'
import type { TranscriptItem } from '@/lib/rewind'
import { isAgentTool } from '@/lib/subtasks'
import { rendersContent, rowCalls, rowResults, subagentOf } from '@/lib/transcript'

/** `tool` rows may fold into a group, `quiet` rows show nothing, `break` rows show on their own. */
export type RowRole = 'tool' | 'quiet' | 'break'

/** A row shown on its own, or a run of tool calls folded into one group row. */
export type Segment = { type: 'row'; row: MessageRow } | { type: 'tools'; rows: readonly MessageRow[]; calls: number }

/** What decides whether a row shows in a transcript, as the transcript itself decides it. */
export interface RoleContext {
  hiddenInits: ReadonlySet<number>
  /** Calls whose rows are loaded; a result without its call shows on its own. */
  calls: ReadonlySet<string>
  subagentRows: boolean
  /** Rows with a divider before them, which always starts a new group. */
  notes: ReadonlyMap<number, unknown>
}

/** Subagents and monitors keep a row of their own, so a running one is never folded away. */
const foldable = (name: string) => !isAgentTool(name) && name !== 'Monitor' && name !== 'AskUserQuestion'

export function rowRole(row: MessageRow, context: RoleContext): RowRole {
  if (context.notes.has(row.id) || row.kind !== 'sdk') {
    return 'break'
  }
  if (!context.subagentRows && subagentOf(row) !== null) {
    return 'quiet'
  }
  const { payload } = row
  if (payload.type === 'system' && payload.subtype === 'init') {
    return context.hiddenInits.has(row.id) ? 'quiet' : 'break'
  }
  const calls = rowCalls(row)
  if (calls.length > 0 && payload.type === 'assistant') {
    const spoken = payload.message.content.some((block) => block.type === 'text' && block.text.trim() !== '')
    return spoken || !calls.every((call) => foldable(call.name)) ? 'break' : 'tool'
  }
  if (rowResults(row).some((ref) => !context.calls.has(ref.block.tool_use_id))) {
    return 'break'
  }
  return rendersContent(row) ? 'break' : 'quiet'
}

/** Fewest calls a run needs to fold; one call stays a row, so a second one swaps in place. */
const MIN_CALLS = 2

/** Folds runs of calls with nothing shown between them; a group runs up to the next shown row. */
export function groupRows(rows: readonly MessageRow[], role: (row: MessageRow) => RowRole): Segment[] {
  const segments: Segment[] = []
  let run: MessageRow[] = []
  let calls = 0
  const flush = () => {
    if (calls >= MIN_CALLS) {
      segments.push({ type: 'tools', rows: run, calls })
    } else {
      segments.push(...run.map((row) => ({ type: 'row' as const, row })))
    }
    run = []
    calls = 0
  }
  for (const row of rows) {
    const kind = role(row)
    if (kind === 'tool') {
      run.push(row)
      calls += rowCalls(row).length
    } else if (kind === 'quiet' && run.length > 0) {
      run.push(row)
    } else {
      flush()
      segments.push({ type: 'row', row })
    }
  }
  flush()
  return segments
}

/** A transcript entry as shown: a row or group of calls, a rewind note, or a rewound fold. */
export type TranscriptView =
  | Segment
  | { type: 'note'; rewind: TaskRewind }
  | { type: 'rewound'; rewind: TaskRewind; rows: readonly MessageRow[]; count: number; segments: Segment[] }

/** Folds runs of tool calls among the transcript's rows and inside rewound folds; null folds none. */
export function transcriptViews(
  items: readonly TranscriptItem[],
  role: ((row: MessageRow) => RowRole) | null,
): TranscriptView[] {
  const segment = (rows: readonly MessageRow[]): Segment[] =>
    role === null ? rows.map((row) => ({ type: 'row', row })) : groupRows(rows, role)
  const views: TranscriptView[] = []
  let run: MessageRow[] = []
  const flush = () => {
    views.push(...segment(run))
    run = []
  }
  for (const item of items) {
    if (item.type === 'row') {
      run.push(item.row)
      continue
    }
    flush()
    views.push(item.type === 'note' ? item : { ...item, segments: segment(item.rows) })
  }
  flush()
  return views
}
