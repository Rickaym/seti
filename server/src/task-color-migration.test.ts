import { AGENT_COLOR_PRESETS } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const SEED = `INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES
  ('old', 'Before colours', '/tmp', 'idle', '2026-01-01', 'x');`

describe('the task colour migration', () => {
  it('adds a nullable colour that existing tasks leave empty', async () => {
    const result = await migrateWith('task_color', SEED, async (tx) => {
      const rows = await tx<{ color: string | null }[]>`SELECT color FROM task WHERE id = 'old'`
      await tx`INSERT INTO task (id, title, cwd, status, created_at, updated_at)
        VALUES ('new', 'After colours', '/tmp', 'idle', '2026-01-02', 'x')`
      const fresh = await tx<{ color: string | null }[]>`SELECT color FROM task WHERE id = 'new'`
      return { existing: rows[0]?.color, fresh: fresh[0]?.color }
    })
    expect(result).toEqual({ existing: null, fresh: null })
  })
})

const NAMED = ['green', 'teal', 'sky', 'blue', 'indigo', 'violet', 'pink'] as const

describe('the task colour hex migration', () => {
  it('turns each hue name into the hex of the preset that kept the name and leaves none alone', async () => {
    const seed = [...NAMED.map((name) => `'${name}'`), 'NULL']
      .map(
        (color, i) =>
          `INSERT INTO task (id, title, cwd, status, created_at, updated_at, color) VALUES
          ('t${String(i)}', 'Agent', '/tmp', 'idle', '2026-01-01', 'x', ${color});`,
      )
      .join('\n')
    const rows = await migrateWith(
      'task_color_hex',
      seed,
      async (tx) => tx<{ id: string; color: string | null }[]>`SELECT id, color FROM task ORDER BY id`,
    )
    const presets = new Map<string, string>(AGENT_COLOR_PRESETS.map((preset) => [preset.name, preset.hex]))
    expect(rows.map((row) => row.color)).toEqual([...NAMED.map((name) => presets.get(name)), null])
  })
})
