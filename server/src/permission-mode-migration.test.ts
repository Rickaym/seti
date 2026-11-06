import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const SEED = `
  INSERT INTO task (id, title, cwd, status, created_at, updated_at, permission_mode) VALUES
    ('old', 'Old', '/tmp', 'idle', 'x', 'x', 'bypassPermissions'),
    ('edits', 'Edits', '/tmp', 'idle', 'x', 'x', 'acceptEdits'),
    ('fresh', 'Fresh', '/tmp', 'idle', 'x', 'x', NULL);`

describe('the permission mode auto migration', () => {
  it('moves agents stored as bypassPermissions to auto and leaves the rest', async () => {
    const modes = await migrateWith(
      'permission_mode_auto',
      SEED,
      async (tx) => tx<{ id: string; permission_mode: string | null }[]>`SELECT id, permission_mode FROM task
        ORDER BY id`,
    )
    expect([...modes]).toEqual([
      { id: 'edits', permission_mode: 'acceptEdits' },
      { id: 'fresh', permission_mode: null },
      { id: 'old', permission_mode: 'auto' },
    ])
  })
})
