import type { MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { DIRECT_HIDDEN, hideDirect } from './direct-privacy.js'

const SECRET = 'the staging key is in vault slot nine'

/** A stored Codex row of one notification. */
const codexRow = (id: number, method: string, params: Record<string, unknown>): MessageRow => ({
  id,
  task_id: 'codex-sender',
  outward: [],
  created_at: '2026-11-24T00:00:00Z',
  kind: 'sdk',
  runtime: 'codex',
  payload: { root: 'thread-1', message: { method, params } },
})

const item = (id: number, fields: Record<string, unknown>) =>
  codexRow(id, 'item/completed', {
    threadId: 'thread-1',
    item: { id: `item-${String(id)}`, status: 'completed', ...fields },
  })

const rows = [
  item(1, {
    type: 'mcpToolCall',
    server: 'seti',
    tool: 'post_team_chat',
    arguments: { to: '@bob', text: SECRET },
    result: { content: [{ type: 'text', text: JSON.stringify({ message: { text: SECRET, to_kind: 'ea' } }) }] },
  }),
  item(2, {
    type: 'commandExecution',
    command: `cat >> chat.md <<'EOF'\ndirect @bob ${SECRET}\nEOF`,
    commandActions: [{ type: 'unknown', command: `cat >> chat.md <<'EOF'\ndirect @bob ${SECRET}\nEOF` }],
    aggregatedOutput: '',
  }),
  item(3, {
    type: 'commandExecution',
    command: 'cat chat.md',
    aggregatedOutput: `### 4 alice, direct to bob\n${SECRET}`,
  }),
  item(4, {
    type: 'fileChange',
    changes: [
      { path: '/work/notes.md', kind: { type: 'update' }, diff: '+plain note' },
      { path: '/work/chat.md', kind: { type: 'update' }, diff: `@@\n+direct @bob ${SECRET}` },
    ],
  }),
  codexRow(5, 'item/commandExecution/outputDelta', { itemId: 'item-3', delta: `"direct": true ${SECRET}` }),
  item(6, { type: 'commandExecution', command: 'ls', aggregatedOutput: 'README.md' }),
]

describe('direct messages in a Codex agent', () => {
  it('shows another agent or a mod none of what a direct message said', async () => {
    for (const reader of [
      { kind: 'mod', modId: 'ops' },
      { kind: 'task', taskId: 'codex-third' },
    ] as const) {
      const shown = await hideDirect('codex-sender', rows, reader)
      expect(JSON.stringify(shown)).not.toContain(SECRET)
      expect(shown[5]).toBe(rows[5])
    }
  })

  it('hides only the parts that carry one, and keeps who it went to', async () => {
    const shown = await hideDirect('codex-sender', rows, { kind: 'mod', modId: 'ops' })
    const params = (index: number) =>
      (shown[index]?.payload as { message: { params: Record<string, unknown> } }).message.params
    const itemOf = (index: number) => params(index).item as Record<string, unknown>
    expect(itemOf(0).arguments).toEqual({ to: '@bob', text: DIRECT_HIDDEN })
    expect(itemOf(1)).toMatchObject({ command: DIRECT_HIDDEN, commandActions: [], aggregatedOutput: '' })
    expect(itemOf(2)).toMatchObject({ command: 'cat chat.md', aggregatedOutput: DIRECT_HIDDEN })
    expect(itemOf(3).changes).toEqual([
      { path: '/work/notes.md', kind: { type: 'update' }, diff: '+plain note' },
      { path: '/work/chat.md', kind: { type: 'update' }, diff: DIRECT_HIDDEN },
    ])
    expect(params(4).delta).toBe(DIRECT_HIDDEN)
  })

  it('shows the user and the agent itself everything', async () => {
    expect(await hideDirect('codex-sender', rows, { kind: 'user' })).toEqual(rows)
    expect(await hideDirect('codex-sender', rows, { kind: 'task', taskId: 'codex-sender' })).toEqual(rows)
  })
})
