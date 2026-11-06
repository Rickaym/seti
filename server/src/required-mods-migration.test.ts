import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const SEED = `
  INSERT INTO mod_state (mod_id, enabled, updated_at) VALUES
    ('previews', false, 'x'),
    ('whats-new', false, 'x'),
    ('github-webhooks', true, 'x'),
    ('weather', false, 'x');`

interface Migrated {
  states: { mod_id: string; enabled: boolean }[]
  audit: { actor: string; kind: string; subject_id: string; summary: string; detail: string }[]
}

async function migrate(runs: number): Promise<Migrated> {
  return migrateWith(
    'required_mods',
    SEED,
    async (tx) => {
      const states = await tx<Migrated['states']>`SELECT mod_id, enabled FROM mod_state ORDER BY mod_id`
      const audit = await tx<Migrated['audit']>`SELECT actor, kind, subject_id, summary, detail FROM audit_event
        ORDER BY id`
      return { states: [...states], audit: [...audit] }
    },
    runs,
  )
}

describe('the required mods migration', () => {
  it('turns each required mod stored off back on, with an audit event, and leaves the rest', async () => {
    const result = await migrate(1)
    expect(result.states).toEqual([
      { mod_id: 'github-webhooks', enabled: true },
      { mod_id: 'previews', enabled: true },
      { mod_id: 'weather', enabled: false },
      { mod_id: 'whats-new', enabled: true },
    ])
    expect(result.audit.map((event) => [event.actor, event.kind, event.subject_id])).toEqual([
      ['system', 'mod.enabled', 'previews'],
      ['system', 'mod.enabled', 'whats-new'],
    ])
    expect(result.audit[0]?.summary).toBe('Turned the previews mod back on, since it is part of Seti now')
    expect(JSON.parse(result.audit[0]?.detail ?? '{}')).toEqual({ mod: 'previews', required: true })
  })

  it('records nothing more when it runs again', async () => {
    expect((await migrate(2)).audit).toHaveLength(2)
  })
})
