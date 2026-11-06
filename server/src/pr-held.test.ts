import type { PrInput } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { sql } from './db.js'
import { prHeld } from './store/pr-held.js'

const update = (kind: PrInput['kind']): PrInput => ({
  source: 'pr',
  kind,
  subject: 'acme/web#1',
  title: `${kind} on acme/web#1`,
  body: '',
  url: 'https://github.com/acme/web/pull/1',
})

beforeAll(async () => {
  await sql`INSERT INTO task (id, title, cwd, status, input_mode, created_at, updated_at) VALUES
    ('held-lead', 'Lead', '/tmp', 'idle', 'wake', '2026-10-27T08:00:00.000Z', '2026-10-27T08:00:00.000Z'),
    ('held-gone', 'Gone', '/tmp', 'idle', 'wake', '2026-10-27T08:00:00.000Z', '2026-10-27T08:00:00.000Z')`
})

describe('held PR updates', () => {
  it('keeps them per subagent in order until they are dropped, and drops them with the task', async () => {
    await prHeld.hold('held-lead', 'toolu_a', [update('ci_failed')], '2026-10-27T09:00:00.000Z')
    await prHeld.hold('held-lead', 'toolu_a', [update('ci_passed'), update('review')], '2026-10-27T09:05:00.000Z')
    await prHeld.hold('held-gone', 'toolu_b', [update('conflict')], '2026-10-27T09:01:00.000Z')
    const mine = (await prHeld.groups()).filter((group) => group.task_id.startsWith('held-'))
    expect(mine).toEqual([
      { task_id: 'held-lead', tool_use_id: 'toolu_a', since: '2026-10-27T09:00:00.000Z' },
      { task_id: 'held-gone', tool_use_id: 'toolu_b', since: '2026-10-27T09:01:00.000Z' },
    ])
    const rows = await prHeld.of('held-lead', 'toolu_a')
    expect(rows.map((row) => row.input)).toEqual([update('ci_failed'), update('ci_passed'), update('review')])

    await prHeld.drop(rows.slice(0, 2).map((row) => row.id))
    expect((await prHeld.of('held-lead', 'toolu_a')).map((row) => row.input.kind)).toEqual(['review'])
    await sql`DELETE FROM task WHERE id = 'held-gone'`
    expect(await prHeld.of('held-gone', 'toolu_b')).toEqual([])
  })
})
