import os from 'node:os'
import { describe, expect, it } from 'vitest'
import type { Db } from './db.js'
import { sshReach } from './ssh-config.js'
import type { SshHostRow } from './store/ssh.js'
import { migrateWith } from './test-migration.js'

type HostFacts = Omit<SshHostRow, 'user' | 'key_id'>

interface Migrated {
  hosts: HostFacts[]
  logins: { profile_id: string; host: string; user: string; key_id: string }[]
  audit: { actor: string; summary: string; detail: string }[]
  /** Each task's usable hosts and the hosts its ssh config renders, from the migrated rows. */
  reach: Record<string, { usable: string[]; hosts: string[]; firstHops: string[] }>
}

/** Hosts as one set's agents saw them before hosts had keys: with that set's login, or none. */
const asSeenBy = (hosts: readonly HostFacts[], logins: Migrated['logins']): SshHostRow[] =>
  hosts.map((host) => {
    const login = logins.find((entry) => entry.host === host.alias)
    return { ...host, user: login?.user ?? '', key_id: login?.key_id ?? null }
  })

async function reachOf(tx: Db, hosts: HostFacts[], logins: Migrated['logins']): Promise<Migrated['reach']> {
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
    const enabled = hosts.map((host) => host.alias).filter((alias) => choices.get(alias) ?? defaults.has(alias))
    const result = sshReach(
      asSeenBy(
        hosts,
        logins.filter((login) => login.profile_id === task.profile_id),
      ),
      enabled,
    )
    reach[task.id] = {
      usable: result.usable,
      hosts: result.hosts.map((host) => host.alias),
      firstHops: result.firstHops,
    }
  }
  return reach
}

async function migrateHosts(seed: string): Promise<Migrated> {
  return migrateWith('ssh_hosts', seed, async (tx) => {
    const hosts = await tx<HostFacts[]>`SELECT * FROM ssh_host ORDER BY alias`
    const logins = await tx<Migrated['logins']>`SELECT profile_id, host, username AS user, key_id FROM ssh_login
      ORDER BY profile_id, host`
    const audit = await tx<Migrated['audit']>`SELECT actor, summary, detail FROM audit_event
      WHERE kind = 'system.ssh_migrated'`
    return { hosts: [...hosts], logins: [...logins], audit: [...audit], reach: await reachOf(tx, hosts, logins) }
  })
}

const KEYS = `
  INSERT INTO ssh_key (id, name, type, public_key, fingerprint, source, created_at) VALUES
    ('key-pbx', 'voip', 'ssh-ed25519', 'ssh-ed25519 AAAA voip', 'SHA256:pbx', 'generated', '2026-09-30T09:36:18.805Z'),
    ('key-exp', 'experimental-1', 'ssh-ed25519', 'ssh-ed25519 BBBB e', 'SHA256:exp', 'generated',
      '2026-09-30T21:25:39.029Z');`

const LIVE = `
  INSERT INTO ssh_settings (id, config, updated_at) VALUES (1,
    E'Host voip\\n    HostName 198.51.100.170\\n    User root\\n\\nHost gpu-box\\n    HostName 203.0.113.54\\n    User root',
    '2026-09-30T21:30:06.834Z');
  ${KEYS}
  INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES
    ('llm', 'LLM Test Setup', '/tmp', 'idle', 'x', 'x'), ('plain', 'Plain', '/tmp', 'idle', 'x', 'x');
  INSERT INTO task_access (task_id, kind, item, enabled) VALUES ('llm', 'ssh', 'gpu-box', true), ('llm', 'ssh', 'voip', true);`

describe('the ssh hosts migration', () => {
  it('moves the live config into hosts and Default logins, and the agent keeps both hosts', async () => {
    const result = await migrateHosts(LIVE)
    expect(
      result.hosts.map(({ alias, hostname, port, jump, options }) => ({ alias, hostname, port, jump, options })),
    ).toEqual([
      { alias: 'gpu-box', hostname: '203.0.113.54', port: 22, jump: null, options: [] },
      { alias: 'voip', hostname: '198.51.100.170', port: 22, jump: null, options: [] },
    ])
    expect(result.logins).toEqual([
      { profile_id: 'default', host: 'gpu-box', user: 'root', key_id: 'key-exp' },
      { profile_id: 'default', host: 'voip', user: 'root', key_id: 'key-pbx' },
    ])
    expect(result.reach).toEqual({
      llm: {
        usable: ['gpu-box', 'voip'],
        hosts: ['gpu-box', 'voip'],
        firstHops: ['203.0.113.54:22', '198.51.100.170:22'],
      },
      plain: { usable: [], hosts: [], firstHops: [] },
    })
    const [event] = result.audit
    expect(event?.actor).toBe('system')
    expect(event?.summary).toBe('Moved the ssh config into 2 hosts and 2 logins')
    expect(JSON.parse(event?.detail ?? '{}')).toEqual({
      hosts: ['voip: 198.51.100.170:22', 'gpu-box: 203.0.113.54:22'],
      logins: ['Default voip: root with voip', 'Default gpu-box: root with experimental-1'],
      guesses: [
        'voip: the key voip is named after the host',
        'gpu-box: experimental-1 is the only key not named after another host',
      ],
      dropped: [],
    })
  })

  it('keeps multi-alias blocks, jump chains and other sets reaching what they reached, dropping unsafe lines', async () => {
    const config = [
      'Host jump',
      '  HostName 203.0.113.9',
      '  User ops',
      '  ForwardAgent yes',
      'Host k8s kube',
      '  HostName 198.51.100.9',
      '  ProxyJump jump',
      '  ServerAliveInterval 30',
      'Host db',
      '  HostName 198.51.100.7',
      '  Port 2222',
      '  LocalCommand touch /tmp/pwned',
    ].join('\\n')
    const result = await migrateHosts(`
      INSERT INTO ssh_settings (id, config, updated_at) VALUES (1, E'${config}', 'x');
      ${KEYS}
      INSERT INTO credential_profile (id, name, aws_region, aws_session_minutes, created_at, updated_at)
        VALUES ('client', 'Client', 'us-east-1', 60, 'x', 'x'), ('idle', 'Idle', 'us-east-1', 60, 'x', 'x');
      INSERT INTO task (id, title, cwd, status, created_at, updated_at, profile_id) VALUES
        ('a', 'A', '/tmp', 'idle', 'x', 'x', 'default'), ('b', 'B', '/tmp', 'idle', 'x', 'x', 'client'),
        ('c', 'C', '/tmp', 'idle', 'x', 'x', 'client');
      INSERT INTO access_default (kind, item, enabled, updated_at) VALUES ('ssh', 'db', true, 'x');
      INSERT INTO task_access (task_id, kind, item, enabled) VALUES
        ('a', 'ssh', 'kube', true), ('b', 'ssh', 'k8s', true), ('b', 'ssh', 'db', false);`)
    const user = os.userInfo().username
    expect(result.hosts.map(({ alias, jump, options }) => [alias, jump, options])).toEqual([
      ['db', null, []],
      ['jump', null, []],
      ['k8s', 'jump', [{ name: 'ServerAliveInterval', value: '30' }]],
      ['kube', 'jump', [{ name: 'ServerAliveInterval', value: '30' }]],
    ])
    expect(result.logins.filter((login) => login.profile_id === 'client')).toEqual([
      { profile_id: 'client', host: 'db', user, key_id: 'key-pbx' },
      { profile_id: 'client', host: 'jump', user: 'ops', key_id: 'key-pbx' },
      { profile_id: 'client', host: 'k8s', user, key_id: 'key-pbx' },
    ])
    expect(result.logins.filter((login) => login.profile_id === 'default').map((login) => login.host)).toEqual([
      'db',
      'jump',
      'k8s',
      'kube',
    ])
    expect(result.logins.some((login) => login.profile_id === 'idle')).toBe(false)
    expect(result.reach).toEqual({
      a: { usable: ['db', 'kube'], hosts: ['db', 'jump', 'kube'], firstHops: ['198.51.100.7:2222', '203.0.113.9:22'] },
      b: { usable: ['k8s'], hosts: ['jump', 'k8s'], firstHops: ['203.0.113.9:22'] },
      c: { usable: ['db'], hosts: ['db'], firstHops: ['198.51.100.7:2222'] },
    })
    const detail = JSON.parse(result.audit[0]?.detail ?? '{}') as { dropped: string[] }
    expect(detail.dropped).toEqual(['jump: ForwardAgent', 'db: LocalCommand'])
    expect(JSON.stringify(result.audit)).not.toContain('pwned')
  })

  it('does nothing without a config', async () => {
    expect(await migrateHosts(KEYS)).toMatchObject({ hosts: [], logins: [], audit: [] })
  })
})
