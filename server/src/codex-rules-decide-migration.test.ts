import { describe, expect, it } from 'vitest'
import type { Db } from './db.js'
import { migrateWith } from './test-migration.js'

const stored = (rulesDecide: boolean) =>
  `INSERT INTO codex_settings (id, enabled, evaluator_decides, updated_at) VALUES (1, true, ${String(rulesDecide)}, 'x');`

const read = async (sql: Db) => {
  const [row] = await sql<{ evaluator_decides: boolean }[]>`SELECT evaluator_decides FROM codex_settings`
  return row?.evaluator_decides
}

describe('the migration that lets rules decide for Codex agents by default', () => {
  it('keeps a choice the user stored, off or on', async () => {
    expect(await migrateWith('codex_rules_decide_default', stored(false), read)).toBe(false)
    expect(await migrateWith('codex_rules_decide_default', stored(true), read)).toBe(true)
  })

  it('lets rules decide for settings first stored after it, and runs twice without harm', async () => {
    const outcome = await migrateWith(
      'codex_rules_decide_default',
      '',
      async (sql) => {
        await sql`INSERT INTO codex_settings (id, enabled, updated_at) VALUES (1, true, 'x')`
        return read(sql)
      },
      2,
    )
    expect(outcome).toBe(true)
  })
})
