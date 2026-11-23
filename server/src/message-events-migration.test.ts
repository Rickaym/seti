import { TURN_COST_KEY } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { messages, sql } from './db.js'
import { storedColumns } from './events/columns.js'
import { goldenCorpus } from './golden/corpus.js'
import type { Db } from './pg.js'
import { fillEventColumns } from './store/event-columns.js'
import { migrateWith } from './test-migration.js'

const TASK = 'events-backfill'
const AT = '2026-11-22T09:00:00.000Z'

const text = (value: string) => ({ type: 'text', text: value })
const user = (content: unknown, parent: string | null = null) => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { role: 'user', content },
})
const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content },
  ...extra,
})

/** Shapes the corpus lacks: odd, empty and unmapped messages, each read the way ingest reads it. */
const ODD: unknown[] = [
  assistant([]),
  assistant([], { error: 'authentication_failed' }),
  assistant('not a list'),
  assistant([{ type: 'server_tool_use' }, text('after')]),
  assistant([{ text: 'no type' }]),
  assistant([{ type: 'thinking', thinking: 'hm' }], { parent_tool_use_id: 'toolu_p' }),
  user('plain'),
  user(''),
  user('[Request interrupted by user for tool use]'),
  user('<local-command-stdout>done</local-command-stdout>'),
  user([{ type: 'image' }]),
  user([text(''), text('[Request interrupted by user]')]),
  user([text('a'), text('b')], 'toolu_p'),
  user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, text('and')], 'toolu_p'),
  { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, duration_ms: 5 },
  { type: 'result', subtype: 'success', is_error: true, result: 'API Error', num_turns: 2, [TURN_COST_KEY]: 0.5 },
  { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9, duration_ms: 1.5 },
  { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: '3', duration_ms: 'slow' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
  { type: 'system', subtype: 'code_change_published', url: 'https://github.com/o/r/pull/1', action: 'created' },
  { type: 'system', subtype: 'code_change_published', action: 'created' },
  { type: 'system', subtype: 'hook_response' },
  { type: 'system', subtype: 'task_progress', task_id: 'a', description: 'd', usage: {} },
  { type: 'tool_progress', tool_use_id: 't1', parent_tool_use_id: 'toolu_p', elapsed_time_seconds: 2 },
  { type: 'stream_event', parent_tool_use_id: 'toolu_p', event: {} },
  { no: 'type' },
]

interface Filled {
  kind: string
  payload: string
  runtime: string
  thread: string
  event: string | null
  agent: boolean
  turn_usd: number | null
  turn_ms: number | null
  turn_steps: number | null
  turn_reply: boolean | null
}

beforeAll(async () => {
  await sql`INSERT INTO task (id, title, cwd, status, created_at, updated_at)
    VALUES (${TASK}, 'Backfill', '/tmp', 'idle', ${AT}, ${AT})`
  const payloads = [
    ...goldenCorpus().flatMap(({ rows }) =>
      rows.flatMap((row) => (row.kind === 'unreadable' ? [] : [{ kind: row.kind, payload: row.payload }])),
    ),
    ...ODD.map((payload) => ({ kind: 'sdk', payload })),
  ]
  for (const { kind, payload } of payloads) {
    await sql`INSERT INTO task_message (task_id, kind, payload, created_at)
      VALUES (${TASK}, ${kind}, ${JSON.stringify(payload)}, ${AT})`
  }
  await fillEventColumns(sql, { batch: 50, restMs: 0 })
})

const filledRows = async () =>
  sql<Filled[]>`SELECT kind, payload, runtime, thread, event, agent, turn_usd, turn_ms, turn_steps, turn_reply
    FROM task_message WHERE task_id = ${TASK} ORDER BY id`

const odd = async (payload: unknown) => (await filledRows()).find((row) => row.payload === JSON.stringify(payload))

describe('the message_events columns', () => {
  it('fills every older row the way ingest fills a new one', async () => {
    const rows = await filledRows()
    expect(rows.length).toBeGreaterThan(ODD.length + 100)
    for (const { kind, payload, ...filled } of rows) {
      expect({ payload, ...filled }).toEqual({ payload, ...storedColumns(kind, payload) })
    }
  })

  it('reads the thread, the leading event, the agent output and the turn end', async () => {
    expect(await odd(ODD[5])).toMatchObject({ thread: 'toolu_p', event: 'reasoning', agent: true })
    expect(await odd(ODD[13])).toMatchObject({ thread: 'toolu_p', event: 'tool.ended', agent: false })
    expect(await odd(ODD[8])).toMatchObject({ event: 'notice', agent: false })
    expect(await odd(ODD[1])).toMatchObject({ event: 'notice', agent: false })
    expect(await odd(ODD[0])).toMatchObject({ thread: '', event: null, agent: false, runtime: 'claude' })
    expect(await odd(ODD[14])).toMatchObject({ event: 'turn.ended', turn_steps: 0, turn_ms: 5, turn_reply: false })
    expect(await odd(ODD[15])).toMatchObject({ turn_usd: 0.5, turn_steps: 2, turn_reply: true })
    expect(await odd(ODD[17])).toMatchObject({ turn_ms: null, turn_steps: null, turn_reply: true })
    expect(await odd(ODD[20])).toMatchObject({ event: 'change.published' })
    expect(await odd(ODD[25])).toMatchObject({ thread: 'toolu_p', event: 'vendor' })
  })

  it('fills a new row at ingest, so the background fill finds nothing left', async () => {
    const row = await messages.insert(TASK, { kind: 'sdk', payload: assistant([text('hi')]) as never }, [])
    const [stored] = await sql<Filled[]>`SELECT kind, payload, runtime, thread, event, agent, turn_usd, turn_ms,
        turn_steps, turn_reply FROM task_message WHERE id = ${row.id}`
    expect(stored).toMatchObject({ event: 'message', agent: true, thread: '', runtime: 'claude' })
    expect(await fillEventColumns(sql)).toBe(0)
  })

  it('adds the columns empty, for the background fill to fill', async () => {
    const payload = JSON.stringify(user([{ type: 'tool_result', tool_use_id: 't9', content: 'ok' }], 'toolu_q'))
    const seed = `
      INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES ('m1', 'A', '/tmp', 'idle', 'x', 'x');
      INSERT INTO task_message (task_id, kind, payload, created_at) VALUES
        ('m1', 'sdk', '${payload}', 'x'), ('m1', 'prompt', '{"text":"hi"}', 'x');`
    const read = async (tx: Db) =>
      tx<Filled[]>`SELECT kind, runtime, thread, event, agent FROM task_message ORDER BY id`
    const rows = await migrateWith('message_events', seed, async (tx) => [
      await read(tx),
      await fillEventColumns(tx, { batch: 1, restMs: 0 }),
      await read(tx),
    ])
    expect(rows).toEqual([
      [
        { kind: 'sdk', runtime: null, thread: null, event: null, agent: null },
        { kind: 'prompt', runtime: null, thread: null, event: null, agent: null },
      ],
      2,
      [
        { kind: 'sdk', runtime: 'claude', thread: 'toolu_q', event: 'tool.ended', agent: false },
        { kind: 'prompt', runtime: 'claude', thread: '', event: null, agent: false },
      ],
    ])
  })
})
