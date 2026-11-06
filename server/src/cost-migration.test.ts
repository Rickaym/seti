import { TURN_COST_KEY } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { ArchiveWriter, type StoredMessage } from './archive-codec.js'
import { migrateWith } from './test-migration.js'

const result = (session: string, total: number) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id: session,
    total_cost_usd: total,
  })

const assistant = JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [] } })

const task = (id: string, cost: number) =>
  `INSERT INTO task (id, title, cwd, status, cost_usd, created_at, updated_at)
    VALUES ('${id}', 'Agent', '/tmp', 'idle', ${String(cost)}, '2026-01-01', 'x');`

const message = (id: number, taskId: string, payload: string) =>
  `INSERT INTO task_message (id, task_id, kind, payload, created_at)
    VALUES (${String(id)}, '${taskId}', 'sdk', '${payload}', '2026-01-01');`

async function archiveSeed(taskId: string, payloads: readonly string[]): Promise<string> {
  const writer = new ArchiveWriter()
  const rows: StoredMessage[] = payloads.map((payload, i) => ({
    id: 1000 + i,
    kind: 'sdk',
    payload,
    outward: '[]',
    created_at: '2026-01-01',
  }))
  await writer.add(rows)
  const encoded = await writer.finish()
  return `INSERT INTO task_archive (task_id, codec, blob, chunks, row_count, raw_bytes, stored_bytes, table_bytes,
      sha256, actor, archived_at)
    VALUES ('${taskId}', '${encoded.codec}', '\\x${encoded.blob.toString('hex')}'::bytea,
      '${JSON.stringify(encoded.chunks)}', ${String(encoded.rows)}, ${String(encoded.raw_bytes)},
      ${String(encoded.blob.length)}, 0, '${encoded.sha256}', 'user', '2026-01-02');
    UPDATE task SET archived_at = '2026-01-02' WHERE id = '${taskId}';`
}

interface Outcome {
  costs: Record<string, number>
  turns: unknown[]
  sessions: { task_id: string; session_id: string; total_usd: number }[]
}

describe('the task cost recount', () => {
  it('counts each turn once from the stored running totals, archived ones too', async () => {
    const seed = [
      task('live', 0.1 + 0.3 + 0.6 + 0.2 + 0.25),
      message(1, 'live', result('s1', 0.1)),
      message(2, 'live', assistant),
      message(3, 'live', result('s1', 0.3)),
      message(4, 'live', result('s1', 0.6)),
      message(5, 'live', result('s2', 0.2)),
      message(6, 'live', result('s2', 0.25)),
      message(7, 'live', result('s2', 0.1)),
      task('empty', 4.5),
      task('archived', 9),
      await archiveSeed('archived', [result('a1', 1), assistant, result('a1', 3), result('a1', 2.5)]),
    ].join('\n')
    const outcome = await migrateWith<Outcome>('task_cost_session', seed, async (tx) => {
      const tasks = await tx<{ id: string; cost_usd: number }[]>`SELECT id, cost_usd FROM task`
      const turns = await tx<{ payload: string }[]>`SELECT payload FROM task_message
        WHERE task_id = 'live' AND (payload::json ->> 'type') = 'result' ORDER BY id`
      const sessions = await tx<Outcome['sessions']>`SELECT task_id, session_id, total_usd FROM task_cost_session
        ORDER BY task_id`
      return {
        costs: Object.fromEntries(tasks.map((row) => [row.id, Number(row.cost_usd.toFixed(6))])),
        turns: turns.map((row) => (JSON.parse(row.payload) as Record<string, unknown>)[TURN_COST_KEY]),
        sessions: [...sessions],
      }
    })
    expect(outcome.costs).toEqual({ live: 0.85, empty: 4.5, archived: 3 })
    expect(outcome.turns.map((cost) => (cost === undefined ? null : Number(cost).toFixed(2)))).toEqual([
      '0.10',
      '0.20',
      '0.30',
      '0.20',
      '0.05',
      null,
    ])
    expect(outcome.sessions).toEqual([
      { task_id: 'archived', session_id: 'a1', total_usd: 2.5 },
      { task_id: 'live', session_id: 's2', total_usd: 0.1 },
    ])
  })
})
