import { beforeAll, describe, expect, it } from 'vitest'
import { sql, tasks } from './db.js'
import { prDiscoveryStore, prDismissals } from './store/pr-discovery.js'

let firstId = 0

beforeAll(async () => {
  await sql`INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES
    ('imported', 'Imported', '/tmp', 'idle', '2026-09-27T08:00:00.000Z', '2026-09-27T08:00:00.000Z'),
    ('empty', 'Empty', '/tmp', 'idle', '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z')`
  const rows = await sql<{ id: number }[]>`INSERT INTO task_message (task_id, kind, payload, created_at) VALUES
    ('imported', 'sdk', '{"text":"https://github.com/acme/app/pull/3"}', '2026-09-25T09:00:00.000Z'),
    ('imported', 'prompt', '{"text":"hello"}', '2026-09-24T19:00:00.000Z'),
    ('imported', 'sdk', '{"text":"no link"}', '2026-09-25T10:00:00.000Z')
    RETURNING id`
  firstId = rows[0]?.id ?? 0
  await tasks.linkPr('imported', 'https://github.com/acme/app/pull/1', 'import')
})

describe('PR discovery store', () => {
  it('starts every task with no cursor', async () => {
    expect((await tasks.get('imported'))?.pr_urls).toEqual(['https://github.com/acme/app/pull/1'])
    expect(await prDiscoveryStore.cursor('imported')).toBe(0)
  })

  it('reads PR-opening and pushing calls, their results and change reports, within the range', async () => {
    const use = (id: string, command: string) =>
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
      })
    const result = (id: string, content: string) =>
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
    await sql`INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES
      ('pusher', 'Pusher', '/tmp', 'idle', '2026-09-27T08:00:00.000Z', '2026-09-27T08:00:00.000Z')`
    const rows = [
      ['pusher', use('tu1', 'git push -u origin fix/x')],
      ['pusher', use('tu2', 'gh pr view 7')],
      ['imported', result('tu1', 'from another task')],
      ['pusher', JSON.stringify({ type: 'system', subtype: 'task_started', tool_use_id: 'tu1' })],
      ['pusher', result('tu2', 'https://github.com/acme/app/pull/7')],
      ['pusher', result('tu1', '')],
      ['pusher', use('tu3', 'gh pr create --fill')],
      ['pusher', result('tu3', 'https://github.com/acme/app/pull/8')],
      ['pusher', JSON.stringify({ type: 'system', subtype: 'code_change_published', url: 'u', action: 'pushed' })],
    ]
    const ids: number[] = []
    for (const [task, payload] of rows) {
      const [row] = await sql<{ id: number }[]>`INSERT INTO task_message (task_id, kind, payload, created_at)
        VALUES (${task ?? ''}, 'sdk', ${payload ?? ''}, '2026-09-27T09:00:00.000Z') RETURNING id`
      ids.push(row?.id ?? 0)
    }
    const payloads = async (upTo: number) =>
      (await prDiscoveryStore.evidenceRows('pusher', upTo)).map((row) => row.payload)
    const at = (index: number) => rows[index]?.[1]
    expect(await payloads(ids[8] ?? 0)).toEqual([at(0), at(5), at(6), at(7), at(8)])
    expect(await payloads(ids[6] ?? 0)).toEqual([at(0), at(5), at(6)])
  })

  it('reads only rows that may hold a PR URL, within the given range', async () => {
    const last = await prDiscoveryStore.lastMessageId('imported')
    expect(await prDiscoveryStore.rowsBetween('imported', 0, last)).toEqual([
      { kind: 'sdk', payload: '{"text":"https://github.com/acme/app/pull/3"}' },
    ])
    expect(await prDiscoveryStore.rowsBetween('imported', firstId, last)).toEqual([])
    expect(await prDiscoveryStore.lastMessageId('empty')).toBe(0)
  })

  it('keeps cursors and dismissals', async () => {
    await prDiscoveryStore.setCursor('imported', 3)
    await prDismissals.add('imported', 'https://github.com/acme/app/pull/3')
    expect(await prDiscoveryStore.cursor('imported')).toBe(3)
    expect(await prDismissals.list('imported')).toEqual(new Set(['https://github.com/acme/app/pull/3']))
  })

  it('drops cursors and dismissals with their task', async () => {
    await tasks.remove('imported')
    expect(await prDiscoveryStore.cursor('imported')).toBe(0)
    expect((await prDismissals.list('imported')).size).toBe(0)
    expect(await prDiscoveryStore.taskIds()).toEqual(['pusher', 'empty'])
  })
})
