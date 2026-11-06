import os from 'node:os'
import { describe, expect, it } from 'vitest'
import type { Db } from './db.js'
import { reachKeys, sshReach } from './ssh-config.js'
import type { SshHostRow } from './store/ssh.js'
import { migrateWith } from './test-migration.js'

interface Migrated {
  hosts: Pick<SshHostRow, 'alias' | 'hostname' | 'port' | 'user' | 'key_id' | 'jump'>[]
  access: { task_id: string; item: string; enabled: boolean }[]
  /** Each task's usable hosts and the keys its sandbox gets, from the migrated rows alone. */
  reach: Record<string, { usable: string[]; keys: string[] }>
  loginTable: string | null
  audit: { summary: string; detail: string }[]
}

async function reachOf(tx: Db, hosts: SshHostRow[]): Promise<Migrated['reach']> {
  const defaults = new Set(
    (await tx<{ item: string }[]>`SELECT item FROM access_default WHERE kind = 'ssh' AND enabled`).map((r) => r.item),
  )
  const reach: Migrated['reach'] = {}
  for (const task of await tx<{ id: string; profile_id: string }[]>`SELECT id, profile_id FROM task ORDER BY id`) {
    const choices = new Map(
      (
        await tx<{ item: string; enabled: boolean }[]>`SELECT item, enabled FROM task_access
          WHERE task_id = ${task.id} AND kind = 'ssh'`
      ).map((row) => [row.item, row.enabled]),
    )
    const bundled = new Set(
      (
        await tx<{ host: string }[]>`SELECT host FROM credential_profile_ssh_host WHERE profile_id = ${task.profile_id}`
      ).map((row) => row.host),
    )
    const enabled = hosts
      .map((host) => host.alias)
      .filter((alias) => bundled.has(alias) || (choices.get(alias) ?? defaults.has(alias)))
    const result = sshReach(hosts, enabled)
    reach[task.id] = { usable: result.usable, keys: reachKeys(result.hosts) }
  }
  return reach
}

async function migrate(seed: string, runs = 1): Promise<Migrated> {
  return migrateWith(
    'ssh_host_keys',
    seed,
    async (tx) => {
      const hosts = await tx<SshHostRow[]>`SELECT alias, hostname, port, username AS user, key_id, jump, options,
        created_at, updated_at FROM ssh_host ORDER BY lower(alias), alias`
      const access = await tx<Migrated['access']>`SELECT task_id, item, enabled FROM task_access WHERE kind = 'ssh'
        ORDER BY task_id, item`
      const [table] = await tx<{ found: string | null }[]>`SELECT to_regclass('ssh_login')::text AS found`
      const audit = await tx<Migrated['audit']>`SELECT summary, detail FROM audit_event
        WHERE kind = 'system.ssh_migrated'`
      return {
        hosts: hosts.map(({ alias, hostname, port, user, key_id, jump }) => ({
          alias,
          hostname,
          port,
          user,
          key_id,
          jump,
        })),
        access: [...access],
        reach: await reachOf(tx, hosts),
        loginTable: table?.found ?? null,
        audit: [...audit],
      }
    },
    runs,
  )
}

const KEYS = `
  INSERT INTO ssh_key (id, name, type, public_key, fingerprint, source, created_at) VALUES
    ('key-pbx', 'voip', 'ssh-ed25519', 'ssh-ed25519 AAAA voip', 'SHA256:pbx', 'generated', '2026-09-30T09:36:18Z'),
    ('key-exp', 'experimental-1', 'ssh-ed25519', 'ssh-ed25519 BBBB e', 'SHA256:exp', 'generated', '2026-09-30T21:25Z');`

const host = (alias: string, hostname: string, port = 22, jump = 'NULL') =>
  `('${alias}', '${hostname}', ${String(port)}, ${jump}, '[]', 'x', 'x')`

const LIVE = `
  ${KEYS}
  INSERT INTO ssh_host (alias, hostname, port, jump, options, created_at, updated_at) VALUES
    ${host('gpu-box', '203.0.113.54')}, ${host('voip', '198.51.100.170')};
  INSERT INTO ssh_login (profile_id, host, username, key_id, created_at, updated_at) VALUES
    ('default', 'gpu-box', 'root', 'key-exp', 'x', 'x'), ('default', 'voip', 'root', 'key-pbx', 'x', 'x');
  INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES
    ('llm', 'LLM', '/tmp', 'idle', 'x', 'x'), ('plain', 'Plain', '/tmp', 'idle', 'x', 'x');
  INSERT INTO task_access (task_id, kind, item, enabled) VALUES
    ('llm', 'ssh', 'gpu-box', true), ('llm', 'ssh', 'voip', true);`

/** Default and Client log in to k8s and db differently, Idle has no login, db is on by default. */
const SPLIT = `
  ${KEYS}
  INSERT INTO credential_profile (id, name, aws_region, aws_session_minutes, created_at, updated_at)
    VALUES ('client', 'Client', 'us-east-1', 60, 'x', 'x'), ('idle', 'Idle', 'us-east-1', 60, 'x', 'x');
  INSERT INTO ssh_host (alias, hostname, port, jump, options, created_at, updated_at) VALUES
    ${host('jump', '203.0.113.9')}, ${host('db', '198.51.100.7', 2222)}, ${host('spare', '192.0.2.1')};
  INSERT INTO ssh_host (alias, hostname, port, jump, options, created_at, updated_at) VALUES
    ${host('k8s', '198.51.100.9', 22, "'jump'")};
  INSERT INTO ssh_login (profile_id, host, username, key_id, created_at, updated_at) VALUES
    ('default', 'jump', 'ops', 'key-pbx', 'x', 'x'), ('default', 'k8s', 'root', 'key-pbx', 'x', 'x'),
    ('default', 'db', 'root', 'key-pbx', 'x', 'x'), ('client', 'jump', 'ops', 'key-pbx', 'x', 'x'),
    ('client', 'k8s', 'ubuntu', 'key-exp', 'x', 'x'), ('client', 'db', 'root', 'key-exp', 'x', 'x');
  INSERT INTO task (id, title, cwd, status, created_at, updated_at, profile_id) VALUES
    ('a', 'A', '/tmp', 'idle', 'x', 'x', 'default'), ('b', 'B', '/tmp', 'idle', 'x', 'x', 'client'),
    ('c', 'C', '/tmp', 'idle', 'x', 'x', 'client'), ('d', 'D', '/tmp', 'idle', 'x', 'x', 'idle');
  INSERT INTO access_default (kind, item, enabled, updated_at) VALUES ('ssh', 'db', true, 'x');
  INSERT INTO task_access (task_id, kind, item, enabled) VALUES
    ('a', 'ssh', 'k8s', true), ('b', 'ssh', 'k8s', true), ('b', 'ssh', 'db', false), ('d', 'ssh', 'k8s', true);`

describe('the ssh host keys migration', () => {
  it('gives each host the login its sets shared, and agents keep what they reached', async () => {
    const result = await migrate(LIVE)
    expect(result.hosts).toEqual([
      { alias: 'gpu-box', hostname: '203.0.113.54', port: 22, user: 'root', key_id: 'key-exp', jump: null },
      { alias: 'voip', hostname: '198.51.100.170', port: 22, user: 'root', key_id: 'key-pbx', jump: null },
    ])
    expect(result.reach).toEqual({
      llm: { usable: ['gpu-box', 'voip'], keys: ['key-exp', 'key-pbx'] },
      plain: { usable: [], keys: [] },
    })
    expect(result.loginTable).toBeNull()
    expect(result.audit.map((event) => event.summary)).toEqual(['Gave each of 2 ssh hosts its own user and key'])
  })

  it('splits a host sets logged in to differently, and every agent reaches the same hosts as before', async () => {
    const result = await migrate(SPLIT)
    expect(result.hosts.map(({ alias, user, key_id, jump }) => [alias, user, key_id, jump])).toEqual([
      ['db', 'root', 'key-pbx', null],
      ['db-root', 'root', 'key-exp', null],
      ['jump', 'ops', 'key-pbx', null],
      ['k8s', 'root', 'key-pbx', 'jump'],
      ['k8s-ubuntu', 'ubuntu', 'key-exp', 'jump'],
      ['spare', os.userInfo().username, null, null],
    ])
    expect(result.hosts.find((entry) => entry.alias === 'db-root')).toMatchObject({
      hostname: '198.51.100.7',
      port: 2222,
    })
    expect(result.reach).toEqual({
      a: { usable: ['db', 'k8s'], keys: ['key-pbx'] },
      b: { usable: ['k8s-ubuntu'], keys: ['key-pbx', 'key-exp'] },
      c: { usable: ['db-root'], keys: ['key-exp'] },
      d: { usable: [], keys: [] },
    })
    expect(result.access).toEqual([
      { task_id: 'a', item: 'k8s', enabled: true },
      { task_id: 'b', item: 'db', enabled: false },
      { task_id: 'b', item: 'k8s-ubuntu', enabled: true },
      { task_id: 'c', item: 'db', enabled: false },
      { task_id: 'c', item: 'db-root', enabled: true },
      { task_id: 'd', item: 'db', enabled: false },
    ])
    const [event] = result.audit
    expect(event?.summary).toBe(
      'Gave each of 4 ssh hosts its own user and key, adding 2 for sets that logged in differently',
    )
    expect(JSON.parse(event?.detail ?? '{}')).toMatchObject({
      hosts: expect.arrayContaining([
        'k8s-ubuntu: ubuntu with experimental-1 (from k8s)',
        'spare: no login yet',
      ]) as unknown,
    })
  })

  it('changes nothing when it runs again', async () => {
    const once = await migrate(SPLIT)
    const twice = await migrate(SPLIT, 2)
    expect(twice).toEqual(once)
  })

  it('does nothing without hosts', async () => {
    expect(await migrate(KEYS)).toMatchObject({ hosts: [], access: [], audit: [], loginTable: null })
  })
})
