import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const tasks = (ids: string[]) =>
  ids.map(
    (id) => `INSERT INTO task (id, title, cwd, status, created_at, updated_at)
    VALUES ('${id}', '${id}', '/tmp', 'idle', '2026-11-01', '2026-11-01');`,
  )

const member = (id: string, handle: string) =>
  `INSERT INTO team_member (task_id, handle, muted, updated_at) VALUES ('${id}', '${handle}', 0, '2026-11-01');`

const handles = async (seed: string) =>
  migrateWith('team_active_handle', seed, async (tx) =>
    Object.fromEntries(
      (await tx<{ task_id: string; handle: string }[]>`SELECT task_id, handle FROM team_member`).map((row) => [
        row.task_id,
        row.handle,
      ]),
    ),
  )

describe('team_active_handle migration', () => {
  it('renames an agent called active to active-task and leaves the others alone', async () => {
    const seed = [...tasks(['a', 'b']), member('a', 'active'), member('b', 'build')].join('\n')
    expect(await handles(seed)).toEqual({ a: 'active-task', b: 'build' })
  })

  it('picks a suffixed handle when active-task is taken', async () => {
    const seed = [...tasks(['a', 'b']), member('a', 'active'), member('b', 'active-task')].join('\n')
    const renamed = await handles(seed)
    expect(renamed.b).toBe('active-task')
    expect(renamed.a).toMatch(/^active-task-[0-9a-f]{6}$/)
  })
})
