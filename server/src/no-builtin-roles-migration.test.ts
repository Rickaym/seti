import { describe, expect, it } from 'vitest'
import { RETIRED_ROLES } from './store/schema-roles.js'
import { migrateWith } from './test-migration.js'

interface Pack {
  id: string
  name: string
  description: string
  body: string
  kind: string
  builtin: boolean
  runtime: string | null
  model: string | null
}

interface Outcome {
  packs: Pack[]
  links: { task_id: string; pack_id: string }[]
  audit: { summary: string; detail: string }[]
}

const idOf = (name: string) => RETIRED_ROLES.find((role) => role.name === name)?.id ?? ''
const LEAD = idOf('Lead')
const REVIEWER = idOf('Reviewer')
const WATCHER = idOf('Watcher')
const GUIDE = '5e710000-0000-4000-8000-000000000001'

const task = (id: string, archived = 'NULL') =>
  `INSERT INTO task (id, title, cwd, status, created_at, updated_at, archived_at)
    VALUES ('${id}', '${id}', '/tmp', 'idle', 'x', 'x', ${archived});`

const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`
const builtinRow = (role: (typeof RETIRED_ROLES)[number]) =>
  `('${role.id}', '${role.name}', ${quoted(role.description)}, '', 'role', true, 'x', 'x')`

/** The built-in roles as roles_as_packs seeded them, which the SQL-only test schema leaves out. */
const BUILTINS = `INSERT INTO context_pack (id, name, description, body, kind, builtin, created_at, updated_at)
  VALUES ${RETIRED_ROLES.map(builtinRow).join(', ')};`

async function migrate(seed: string, runs = 1): Promise<Outcome> {
  return migrateWith(
    'no_builtin_roles',
    `${BUILTINS}\n${seed}`,
    async (tx) => {
      const packs = await tx<Pack[]>`SELECT id, name, description, body, kind, builtin, runtime, model
        FROM context_pack ORDER BY name`
      const links = await tx<Outcome['links']>`SELECT task_id, pack_id FROM task_context_pack
        WHERE pack_id <> ${GUIDE} ORDER BY task_id`
      const audit = await tx<Outcome['audit']>`SELECT summary, detail FROM audit_event
        WHERE kind = 'system.roles_migrated' ORDER BY id`
      return { packs: [...packs], links: [...links], audit: [...audit] }
    },
    runs,
  )
}

const roleNames = (outcome: Outcome) => outcome.packs.filter((pack) => pack.kind === 'role').map((pack) => pack.name)

/** Each way an install can refer to a built-in role, and the role it keeps. */
const REFERENCES: [string, string, string][] = [
  ['an agent', 'Lead', `${task('t1')} INSERT INTO task_context_pack (task_id, pack_id) VALUES ('t1', '${LEAD}');`],
  [
    'an archived agent',
    'Reviewer',
    `${task('t2', "'2026-11-01'")} INSERT INTO task_context_pack (task_id, pack_id) VALUES ('t2', '${REVIEWER}');`,
  ],
  ['the EA', 'Watcher', `INSERT INTO ea_context_pack (pack_id, role, linked_at) VALUES ('${WATCHER}', true, 'x');`],
  [
    'a credential',
    'Reviewer',
    `INSERT INTO credential_access (profile_id, kind, item, enabled, updated_at)
      VALUES ('default', 'pack', '${REVIEWER}', true, 'x');`,
  ],
  [
    "a mod's agent filter",
    'Watcher',
    `INSERT INTO mod_grant (mod_id, hash, idx, capability, granted_at)
      VALUES ('m', '${'a'.repeat(64)}', 0, '{"name": "tasks.read", "agents": ["builder", "role:watcher"]}', 'x');`,
  ],
  ['a runtime the user set', 'Reviewer', `UPDATE context_pack SET model = 'gpt-5.5' WHERE id = '${REVIEWER}';`],
]

describe('the no built-in roles migration', () => {
  it('deletes every built-in role on an install that never used one, and keeps the guide', async () => {
    const result = await migrate(task('idle'))
    expect(roleNames(result)).toEqual([])
    expect(result.packs.find((pack) => pack.id === GUIDE)).toMatchObject({ name: 'Seti guide', builtin: true })
    expect(result.audit).toEqual([])
  })

  it('records what it removed on an install with history', async () => {
    const result = await migrate(`INSERT INTO audit_event (at, actor, kind, subject_type, summary, detail)
      VALUES ('x', 'user', 'task.created', 'task', 'Created a task', '{}');`)
    expect(roleNames(result)).toEqual([])
    expect(result.audit.map((event) => event.summary)).toEqual([
      'Seti ships no built-in roles: kept none as your own, removed Lead, Reviewer, Watcher',
    ])
  })

  it.each(REFERENCES)('keeps a role %s refers to as the user own, and deletes the others', async (_, name, seed) => {
    const result = await migrate(seed)
    expect(roleNames(result)).toEqual([name])
    const role = RETIRED_ROLES.find((entry) => entry.name === name)
    expect(result.packs.find((pack) => pack.kind === 'role')).toMatchObject({
      id: role?.id,
      name,
      description: role?.description,
      body: role?.text,
      builtin: false,
    })
    expect(result.audit[0]?.detail).toContain(`"kept":["${name}"]`)
  })

  it('keeps the runtime and model the user gave a kept role', async () => {
    const result = await migrate(
      `${task('t1')} INSERT INTO task_context_pack (task_id, pack_id) VALUES ('t1', '${LEAD}');
      UPDATE context_pack SET runtime = 'codex', model = 'gpt-5.5' WHERE id = '${LEAD}';`,
    )
    expect(result.packs.find((pack) => pack.id === LEAD)).toMatchObject({ runtime: 'codex', model: 'gpt-5.5' })
    expect(result.links).toEqual([{ task_id: 't1', pack_id: LEAD }])
  })

  it('keeps several roles in use at once, and does not count an unlinked row as a use', async () => {
    const result = await migrate(
      `${task('t1')} ${task('t2')}
      INSERT INTO task_context_pack (task_id, pack_id, linked) VALUES ('t1', '${LEAD}', true),
        ('t2', '${WATCHER}', true), ('t2', '${REVIEWER}', false);`,
    )
    expect(roleNames(result)).toEqual(['Lead', 'Watcher'])
    expect(result.links).toEqual([
      { task_id: 't1', pack_id: LEAD },
      { task_id: 't2', pack_id: WATCHER },
    ])
    expect(result.audit[0]?.summary).toBe(
      'Seti ships no built-in roles: kept Lead, Watcher as your own, removed Reviewer',
    )
  })

  it("leaves the user's own roles alone and changes nothing on a second run", async () => {
    const result = await migrate(
      `INSERT INTO context_pack (id, name, description, body, kind, created_at, updated_at)
        VALUES ('mine', 'Release lead', '', 'Ship it.', 'role', 'x', 'x');
      ${task('t1')} INSERT INTO task_context_pack (task_id, pack_id) VALUES ('t1', '${LEAD}');`,
      2,
    )
    expect(roleNames(result)).toEqual(['Lead', 'Release lead'])
    expect(result.packs.find((pack) => pack.id === 'mine')).toMatchObject({ body: 'Ship it.', builtin: false })
    expect(result.audit).toHaveLength(1)
  })
})
