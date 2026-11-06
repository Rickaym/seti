import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageRow, TaskRewind } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { transcriptItems } from '@/lib/rewind'
import { groupRows, rowRole, transcriptViews, type RoleContext, type Segment } from '@/lib/tool-groups'
import { indexTranscript } from '@/lib/transcript'

let nextId = 0

function sdk(payload: Record<string, unknown>): MessageRow {
  nextId += 1
  const message = { session_id: 's', uuid: String(nextId), parent_tool_use_id: null, ...payload }
  return {
    id: nextId,
    task_id: 't',
    outward: [],
    created_at: '2026-10-02T10:00:00.000Z',
    kind: 'sdk',
    payload: message as unknown as SDKMessage,
  }
}

const assistant = (content: unknown[], parent: string | null = null) =>
  sdk({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content } })
const text = (words: string) => assistant([{ type: 'text', text: words }])
const thinking = () => assistant([{ type: 'thinking', thinking: 'hm', signature: '' }])
const call = (id: string, name = 'Bash') => assistant([{ type: 'tool_use', id, name, input: { command: 'ls' } }])
const result = (id: string, isError = false) =>
  sdk({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
  })
const progress = (id: string) => sdk({ type: 'system', subtype: 'task_progress', task_id: 'b', tool_use_id: id })
const prompt = (words: string): MessageRow => {
  nextId += 1
  return {
    id: nextId,
    task_id: 't',
    outward: [],
    created_at: '2026-10-02T10:00:00.000Z',
    kind: 'prompt',
    payload: { text: words },
  }
}

/** A call and its result, with the thinking and progress rows real transcripts put around it. */
const step = (id: string, name = 'Bash', isError = false) => [
  thinking(),
  call(id, name),
  progress(id),
  result(id, isError),
]

function contextFor(rows: readonly MessageRow[], extra: Partial<RoleContext> = {}): RoleContext {
  return { ...indexTranscript(rows), subagentRows: false, notes: new Map(), ...extra }
}

function group(rows: readonly MessageRow[], extra: Partial<RoleContext> = {}): Segment[] {
  const context = contextFor(rows, extra)
  return groupRows(rows, (row) => rowRole(row, context))
}

/** Segments as short strings: a group as "tools:<calls>", a shown row by its kind. */
function shape(segments: readonly Segment[]): string[] {
  return segments.flatMap((segment) => {
    if (segment.type === 'tools') {
      return [`tools:${String(segment.calls)}`]
    }
    const { row } = segment
    if (row.kind !== 'sdk') {
      return [row.kind]
    }
    return rowRoleName(row)
  })
}

function rowRoleName(row: MessageRow): string[] {
  const first = row.kind === 'sdk' && row.payload.type === 'assistant' ? row.payload.message.content[0] : undefined
  if (first?.type === 'tool_use') {
    return [first.name]
  }
  return first?.type === 'text' ? ['text'] : []
}

describe('groupRows', () => {
  it('folds consecutive calls, with their results and progress rows, into one group', () => {
    const rows = [prompt('go'), ...step('a'), ...step('b'), ...step('c'), text('done')]
    const segments = group(rows)
    expect(shape(segments)).toEqual(['prompt', 'tools:3', 'text'])
    const tools = segments.find((segment) => segment.type === 'tools')
    expect(tools?.rows.at(-1)?.id).toBe(rows.at(-2)?.id)
  })

  it('splits groups at assistant text, which stays shown between them', () => {
    const rows = [...step('a'), ...step('b'), text('Image is pushed.'), ...step('c'), ...step('d'), ...step('e')]
    expect(shape(group(rows))).toEqual(['tools:2', 'text', 'tools:3'])
  })

  it('leaves a lone call as its own row', () => {
    const rows = [text('one'), ...step('a'), text('two')]
    expect(shape(group(rows))).toEqual(['text', 'Bash', 'text'])
  })

  it('keeps failed calls inside the group', () => {
    const rows = [...step('a'), ...step('b', 'Bash', true), ...step('c')]
    expect(shape(group(rows))).toEqual(['tools:3'])
  })

  it('keeps the running call, which has no result yet, in the group', () => {
    const rows = [...step('a'), ...step('b'), thinking(), call('c')]
    const segments = group(rows)
    expect(shape(segments)).toEqual(['tools:3'])
    const tools = segments.find((segment) => segment.type === 'tools')
    expect(tools?.rows.at(-1)?.id).toBe(rows.at(-1)?.id)
  })

  it('gives monitors and subagents rows of their own', () => {
    const rows = [
      ...step('a'),
      ...step('b'),
      ...step('m', 'Monitor'),
      ...step('c'),
      ...step('s', 'Agent'),
      ...step('d'),
    ]
    expect(shape(group(rows))).toEqual(['tools:2', 'Monitor', 'Bash', 'Agent', 'Bash'])
  })

  it('skips hidden subagent rows, but groups them in a subtask transcript', () => {
    const inner = [assistant([{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }], 'parent')]
    const rows = [...step('a'), ...inner, ...step('b')]
    expect(shape(group(rows))).toEqual(['tools:2'])
    expect(shape(group(rows, { subagentRows: true }))).toEqual(['tools:3'])
  })

  it('shows a call with a divider note before it on its own row', () => {
    const rows = [...step('a'), ...step('b'), ...step('c'), ...step('d'), ...step('e')]
    const marked = rows[9]?.id ?? 0
    expect(shape(group(rows, { notes: new Map([[marked, { text: 'call started' }]]) }))).toEqual([
      'tools:2',
      'Bash',
      'tools:2',
    ])
  })

  it('shows a result whose call is not loaded on its own', () => {
    const rows = [result('earlier'), ...step('a'), ...step('b')]
    const segments = group(rows)
    expect(segments[0]).toEqual({ type: 'row', row: rows[0] })
    expect(shape(segments.slice(1))).toEqual(['tools:2'])
  })

  it('treats a row of text and a call together as shown text', () => {
    const mixed = assistant([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'm', name: 'Bash', input: {} },
    ])
    const rows = [...step('a'), mixed, ...step('b')]
    expect(group(rows).map((segment) => segment.type)).toEqual([
      'row',
      'row',
      'row',
      'row',
      'row',
      'row',
      'row',
      'row',
      'row',
    ])
  })
})

describe('transcriptViews', () => {
  const rewind = (first: number, last: number): TaskRewind => ({
    id: 1,
    task_id: 't',
    prompt_message_id: first,
    last_message_id: last,
    message_count: last - first + 1,
    prompt_text: 'go',
    restore: 'conversation',
    state: 'applied',
    reason: null,
    files_changed: [],
    created_at: '2026-10-02T10:00:00.000Z',
  })

  it('groups inside a rewound fold and keeps the fold a boundary', () => {
    const before = [prompt('go'), ...step('a'), ...step('b')]
    const after = [prompt('again'), ...step('c'), ...step('d'), ...step('e')]
    const rows = [...before, ...after]
    const first = before[0]?.id ?? 0
    const last = before.at(-1)?.id ?? 0
    const context = contextFor(rows)
    const views = transcriptViews(transcriptItems(rows, [rewind(first, last)]), (row) => rowRole(row, context))
    expect(views.map((view) => view.type)).toEqual(['rewound', 'row', 'row', 'tools'])
    const fold = views[0]
    expect(fold?.type === 'rewound' && shape(fold.segments)).toEqual(['prompt', 'tools:2'])
  })

  it('shows every row on its own when grouping is off', () => {
    const rows = [...step('a'), ...step('b')]
    const views = transcriptViews(transcriptItems(rows, []), null)
    expect(views.every((view) => view.type === 'row')).toBe(true)
    expect(views).toHaveLength(rows.length)
  })
})
