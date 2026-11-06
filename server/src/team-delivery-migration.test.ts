import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const SEED = `
  INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES
    ('target', 'Target', '/tmp', 'idle', '2026-10-01', 'x');
  INSERT INTO team_message (id, author_kind, text, created_at) VALUES (1, 'user', '@target hi', '2026-10-01');
  INSERT INTO team_delivery (message_id, task_id, author_kind, mode, created_at) VALUES
    (1, 'target', 'user', 'interrupt', '2026-10-01'),
    (1, 'target', 'user', 'next', '2026-10-01');`

describe('team_delivery_now migration', () => {
  it('renames interrupt deliveries to now and leaves the other modes alone', async () => {
    const modes = await migrateWith('team_delivery_now', SEED, async (tx) =>
      (await tx<{ mode: string }[]>`SELECT mode FROM team_delivery ORDER BY id`).map((row) => row.mode),
    )
    expect(modes).toEqual(['now', 'next'])
  })
})
