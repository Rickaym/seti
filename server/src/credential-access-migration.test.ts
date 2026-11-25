import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

interface Row {
  task_id: string
  item: string
}

const host = (alias: string) => `('${alias}', '192.0.2.1', 22, NULL, '[]', 'x', 'x')`

/**
 * Default bundles db; Ops bundles db and k8s. Every agent tries every own choice on db and k8s,
 * and spare is on by default, so each way a host could reach an agent before is here.
 */
const SEED = `
  INSERT INTO credential_profile (id, name, aws_region, aws_session_minutes, created_at, updated_at)
    VALUES ('ops', 'Ops', 'us-east-1', 60, 'x', 'x');
  INSERT INTO ssh_host (alias, hostname, port, jump, options, created_at, updated_at) VALUES
    ${host('db')}, ${host('k8s')}, ${host('spare')};
  INSERT INTO credential_profile_ssh_host (profile_id, host, created_at) VALUES
    ('default', 'db', 't1'), ('ops', 'db', 't2'), ('ops', 'k8s', 't3');
  INSERT INTO access_default (kind, item, enabled, updated_at) VALUES ('ssh', 'spare', true, 'x');
  INSERT INTO task (id, title, cwd, status, created_at, updated_at, profile_id) VALUES
    ('plain', 'P', '/tmp', 'idle', 'x', 'x', 'default'), ('offs', 'O', '/tmp', 'idle', 'x', 'x', 'default'),
    ('ons', 'N', '/tmp', 'idle', 'x', 'x', 'default'), ('ops-plain', 'Q', '/tmp', 'idle', 'x', 'x', 'ops'),
    ('ops-offs', 'R', '/tmp', 'idle', 'x', 'x', 'ops');
  INSERT INTO task_access (task_id, kind, item, enabled) VALUES
    ('offs', 'ssh', 'db', false), ('offs', 'ssh', 'k8s', false), ('offs', 'ssh', 'spare', false),
    ('ons', 'ssh', 'k8s', true), ('ops-offs', 'ssh', 'db', false), ('ops-offs', 'ssh', 'k8s', false),
    ('ops-offs', 'aws', 'aws', false);`

/** What each agent reached before: bundled, else its own choice, else the default. */
const BEFORE: Record<string, string[]> = {
  plain: ['db', 'spare'],
  offs: ['db'],
  ons: ['db', 'k8s', 'spare'],
  'ops-plain': ['db', 'k8s', 'spare'],
  'ops-offs': ['db', 'k8s', 'spare'],
}

describe('the credential access migration', () => {
  it('turns bundled hosts into set entries and every agent reaches the same hosts', async () => {
    const result = await migrateWith('credential_access', SEED, async (tx) => {
      const set = await tx<{ profile_id: string; kind: string; item: string; enabled: boolean }[]>`
        SELECT profile_id, kind, item, enabled FROM credential_access ORDER BY profile_id, item`
      const own = await tx<(Row & { kind: string; enabled: boolean })[]>`SELECT task_id, kind, item, enabled
        FROM task_access ORDER BY task_id, kind, item`
      const reached = await tx<Row[]>`SELECT t.id AS task_id, h.alias AS item FROM task t CROSS JOIN ssh_host h
        LEFT JOIN task_access a ON a.task_id = t.id AND a.kind = 'ssh' AND a.item = h.alias
        LEFT JOIN credential_access c ON c.profile_id = t.profile_id AND c.kind = 'ssh' AND c.item = h.alias
        LEFT JOIN access_default d ON d.kind = 'ssh' AND d.item = h.alias
        WHERE COALESCE(a.enabled, c.enabled, d.enabled, false) ORDER BY t.id, h.alias`
      const [old] = await tx<
        { found: string | null }[]
      >`SELECT to_regclass('credential_profile_ssh_host')::text AS found`
      return { set: [...set], own: [...own], reached: [...reached], old: old?.found ?? null }
    })
    expect(result.set).toEqual([
      { profile_id: 'default', kind: 'ssh', item: 'db', enabled: true },
      { profile_id: 'ops', kind: 'ssh', item: 'db', enabled: true },
      { profile_id: 'ops', kind: 'ssh', item: 'k8s', enabled: true },
    ])
    expect(result.own).toEqual([
      { task_id: 'offs', kind: 'ssh', item: 'k8s', enabled: false },
      { task_id: 'offs', kind: 'ssh', item: 'spare', enabled: false },
      { task_id: 'ons', kind: 'ssh', item: 'k8s', enabled: true },
      { task_id: 'ops-offs', kind: 'aws', item: 'aws', enabled: false },
    ])
    const after: Record<string, string[]> = {}
    for (const row of result.reached) {
      after[row.task_id] = [...(after[row.task_id] ?? []), row.item]
    }
    expect(after).toEqual(BEFORE)
    expect(result.old).toBeNull()
  })

  it('leaves agents of an install without bundled hosts untouched', async () => {
    const seed = `
      INSERT INTO ssh_host (alias, hostname, port, jump, options, created_at, updated_at) VALUES ${host('db')};
      INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES ('a', 'A', '/tmp', 'idle', 'x', 'x');
      INSERT INTO task_access (task_id, kind, item, enabled) VALUES ('a', 'ssh', 'db', false);`
    const result = await migrateWith('credential_access', seed, async (tx) => ({
      set: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM credential_access`)[0]?.n,
      hosts: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM credential_host`)[0]?.n,
      own: [...(await tx<{ item: string }[]>`SELECT item FROM task_access`)],
    }))
    expect(result).toEqual({ set: 0, hosts: 0, own: [{ item: 'db' }] })
  })
})
