import { BUILTIN_ROLES } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { rolePackName } from './store/schema-roles.js'
import { migrateWith } from './test-migration.js'

interface Pack {
  id: string
  name: string
  kind: string
  builtin: boolean
  linked_by_default: boolean
  body: string
}

interface Migrated {
  packs: Pack[]
  links: { task_id: string; name: string; linked: boolean }[]
  roleColumn: number
  audit: { actor: string; summary: string; detail: string }[]
}

const LONG = 'A'.repeat(100)

const SEED = `
  INSERT INTO context_pack (id, name, description, body, created_at, updated_at) VALUES
    ('mine', 'Lead', '', 'my own lead notes', 'x', 'x'),
    ('docs', 'Docs role', '', 'taken name', 'x', 'x');
  INSERT INTO task (id, title, cwd, status, created_at, updated_at, role) VALUES
    ('lead', 'Release lead', '/tmp', 'idle', '2026-01-01', 'x', E'Lead: delegate the release.\\n- Own the train.'),
    ('again', 'Release lead', '/tmp', 'idle', '2026-01-02', 'x', 'Second lead.'),
    ('docs-task', 'Docs', '/tmp', 'idle', '2026-01-03', 'x', 'Write the docs.'),
    ('long', '${LONG}', '/tmp', 'idle', '2026-01-04', 'x', 'Long title.'),
    ('plain', 'Plain', '/tmp', 'idle', '2026-01-05', 'x', NULL);`

async function migrate(seed: string): Promise<Migrated> {
  return migrateWith('roles_as_packs', seed, async (tx) => {
    const packs = await tx<Pack[]>`SELECT id, name, kind, builtin, linked_by_default, body FROM context_pack
      ORDER BY name`
    const links = await tx<Migrated['links']>`SELECT tp.task_id, p.name, tp.linked FROM task_context_pack tp
      JOIN context_pack p ON p.id = tp.pack_id ORDER BY tp.task_id, p.name`
    const [column] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'task' AND column_name = 'role'`
    const audit = await tx<Migrated['audit']>`SELECT actor, summary, detail FROM audit_event
      WHERE kind = 'system.roles_migrated'`
    return { packs: [...packs], links: [...links], roleColumn: column?.count ?? -1, audit: [...audit] }
  })
}

describe('the roles as packs migration', () => {
  it('turns each role into a linked role pack, seeds the built-in roles and drops the column', async () => {
    const result = await migrate(SEED)
    const byName = new Map(result.packs.map((pack) => [pack.name, pack]))
    expect(byName.get('Release lead role')).toMatchObject({
      kind: 'role',
      builtin: false,
      linked_by_default: false,
      body: 'Lead: delegate the release.\n- Own the train.',
    })
    expect(byName.get('Release lead role 2')?.body).toBe('Second lead.')
    expect(byName.get('Docs role 2')).toMatchObject({ kind: 'role', body: 'Write the docs.' })
    expect(byName.get('Docs role')).toMatchObject({ kind: 'reference', body: 'taken name' })
    const long = result.packs.find((pack) => pack.body === 'Long title.')
    expect(long?.name).toBe(`${'A'.repeat(75)} role`)
    expect(result.links.filter((link) => link.name !== 'Seti guide')).toEqual([
      { task_id: 'again', name: 'Release lead role 2', linked: true },
      { task_id: 'docs-task', name: 'Docs role 2', linked: true },
      { task_id: 'lead', name: 'Release lead role', linked: true },
      { task_id: 'long', name: `${'A'.repeat(75)} role`, linked: true },
    ])

    for (const role of BUILTIN_ROLES) {
      expect(result.packs.find((pack) => pack.id === role.id)).toMatchObject({
        name: role.name,
        kind: 'role',
        builtin: true,
        linked_by_default: false,
        body: '',
      })
    }
    expect(byName.get('Lead (yours)')).toMatchObject({ id: 'mine', kind: 'reference', body: 'my own lead notes' })
    expect(byName.get('Seti guide')?.kind).toBe('reference')
    expect(result.roleColumn).toBe(0)

    expect(result.audit).toHaveLength(1)
    expect(result.audit[0]?.actor).toBe('system')
    expect(result.audit[0]?.summary).toBe('Moved the roles of 4 agents into role packs linked to them')
    expect(result.audit[0]?.detail).toContain('lead: Release lead role (')
    expect(result.audit[0]?.detail).not.toContain('delegate the release')
  })

  it('records nothing when no agent has a role, as on the live instance', async () => {
    const result = await migrate(`INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES
      ('plain', 'Plain', '/tmp', 'idle', 'x', 'x');`)
    expect(result.packs.filter((pack) => pack.kind === 'role').map((pack) => pack.name)).toEqual([
      'Lead',
      'Reviewer',
      'Watcher',
    ])
    expect(result.links.filter((link) => link.name !== 'Seti guide')).toEqual([])
    expect(result.roleColumn).toBe(0)
    expect(result.audit).toEqual([])
  })

  it('numbers names already taken and keeps them within 80 characters', () => {
    expect(rolePackName('Docs', new Set(['Docs role', 'Docs role 2']))).toBe('Docs role 3')
    expect(rolePackName('B'.repeat(90), new Set([`${'B'.repeat(75)} role`]))).toBe(`${'B'.repeat(73)} role 2`)
  })
})
