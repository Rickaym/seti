import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const SEED = `INSERT INTO task (id, title, cwd, status, created_at, updated_at, seti_control) VALUES
  ('on', 'Had control', '/tmp', 'idle', '2026-01-01', 'x', true),
  ('off', 'Had none', '/tmp', 'idle', '2026-01-01', 'x', false);`

describe('the Seti control level migration', () => {
  it('keeps Full for agents that had control, gives the rest Self and clears the old switch', async () => {
    const rows = await migrateWith('task_seti_level', SEED, async (tx) => {
      await tx`INSERT INTO task (id, title, cwd, status, created_at, updated_at)
        VALUES ('new', 'After levels', '/tmp', 'idle', '2026-01-02', 'x')`
      return tx<{ id: string; seti_level: string; seti_control: boolean }[]>`SELECT id, seti_level, seti_control
        FROM task ORDER BY id`
    })
    expect(rows).toEqual([
      { id: 'new', seti_level: 'self', seti_control: false },
      { id: 'off', seti_level: 'self', seti_control: false },
      { id: 'on', seti_level: 'full', seti_control: false },
    ])
  })
})
