import os from 'node:os'
import { DEFAULT_PROFILE_ID, type AuditDetail } from '@seti/shared'
import type { Db } from '../pg.js'
import { planSshImport, type PlannedHost } from '../ssh-legacy.js'

/** Hosts as facts, and logins per credential set; ssh_settings stays one release for a rollback. */
export const SSH_HOSTS = `
CREATE TABLE ssh_host (
  alias TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL,
  jump TEXT REFERENCES ssh_host(alias),
  options JSONB NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (jump IS NULL OR jump <> alias)
);
CREATE INDEX ssh_host_jump ON ssh_host(jump);

CREATE TABLE ssh_login (
  profile_id TEXT NOT NULL REFERENCES credential_profile(id) ON DELETE CASCADE,
  host TEXT NOT NULL REFERENCES ssh_host(alias) ON DELETE CASCADE,
  username TEXT NOT NULL,
  key_id TEXT NOT NULL REFERENCES ssh_key(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, host)
);
CREATE INDEX ssh_login_host ON ssh_login(host);
CREATE INDEX ssh_login_key ON ssh_login(key_id);
`

interface AccessRow {
  profile_id: string
  task_id: string
  item: string | null
  enabled: boolean | null
}

/** The hosts a connection to `alias` passes, itself first. */
function chainOf(byAlias: ReadonlyMap<string, PlannedHost>, alias: string): string[] {
  const chain: string[] = []
  for (let host = byAlias.get(alias); host !== undefined && !chain.includes(host.alias);) {
    chain.push(host.alias)
    host = host.jump === null ? undefined : byAlias.get(host.jump)
  }
  return chain
}

/** Per credential set other than Default, the hosts its agents reach today, jump hosts included. */
async function reachBySet(tx: Db, hosts: readonly PlannedHost[]): Promise<Map<string, Set<string>>> {
  const byAlias = new Map(hosts.map((host) => [host.alias, host]))
  const defaults = new Set(
    (await tx<{ item: string }[]>`SELECT item FROM access_default WHERE kind = 'ssh' AND enabled`).map((r) => r.item),
  )
  const rows = await tx<AccessRow[]>`SELECT t.profile_id, t.id AS task_id, a.item, a.enabled FROM task t
    LEFT JOIN task_access a ON a.task_id = t.id AND a.kind = 'ssh' WHERE t.profile_id <> ${DEFAULT_PROFILE_ID}`
  const overrides = new Map<string, { profile: string; choices: Map<string, boolean> }>()
  for (const row of rows) {
    const task = overrides.get(row.task_id) ?? { profile: row.profile_id, choices: new Map<string, boolean>() }
    if (row.item !== null && row.enabled !== null) {
      task.choices.set(row.item, row.enabled)
    }
    overrides.set(row.task_id, task)
  }
  const reach = new Map<string, Set<string>>()
  for (const { profile, choices } of overrides.values()) {
    const enabled = hosts.filter((host) => choices.get(host.alias) ?? defaults.has(host.alias))
    const set = reach.get(profile) ?? new Set<string>()
    for (const host of enabled) {
      chainOf(byAlias, host.alias).forEach((alias) => set.add(alias))
    }
    reach.set(profile, set)
  }
  return reach
}

async function insertHosts(tx: Db, hosts: readonly PlannedHost[], at: string): Promise<void> {
  for (const host of hosts) {
    await tx`INSERT INTO ssh_host (alias, hostname, port, jump, options, created_at, updated_at)
      VALUES (${host.alias}, ${host.hostname}, ${host.port}, NULL, ${tx.json(host.options.map((o) => ({ ...o })))},
        ${at}, ${at})`
  }
  for (const host of hosts) {
    if (host.jump !== null) {
      await tx`UPDATE ssh_host SET jump = ${host.jump} WHERE alias = ${host.alias}`
    }
  }
}

/** Hosts and logins from the old config: Default logs in everywhere, other sets where they reach. */
export async function importSshHosts(tx: Db): Promise<void> {
  const [settings] = await tx<{ config: string }[]>`SELECT config FROM ssh_settings WHERE id = 1`
  if (settings === undefined || settings.config.trim() === '') {
    return
  }
  const keys = await tx<{ id: string; name: string }[]>`SELECT id, name FROM ssh_key ORDER BY created_at, id`
  const plan = planSshImport(settings.config, keys, os.userInfo().username)
  const at = new Date().toISOString()
  await insertHosts(tx, plan.hosts, at)
  const names = new Map(
    (await tx<{ id: string; name: string }[]>`SELECT id, name FROM credential_profile`).map((r) => [r.id, r.name]),
  )
  const sets = new Map([[DEFAULT_PROFILE_ID, new Set(plan.hosts.map((host) => host.alias))]])
  for (const [profile, reached] of await reachBySet(tx, plan.hosts)) {
    sets.set(profile, reached)
  }
  const logins: string[] = []
  const keyName = new Map(keys.map((key) => [key.id, key.name]))
  for (const [profile, aliases] of sets) {
    for (const host of plan.hosts.filter((entry) => aliases.has(entry.alias))) {
      if (host.keyId === null) {
        continue
      }
      await tx`INSERT INTO ssh_login (profile_id, host, username, key_id, created_at, updated_at)
        VALUES (${profile}, ${host.alias}, ${host.user}, ${host.keyId}, ${at}, ${at})`
      logins.push(`${names.get(profile) ?? profile} ${host.alias}: ${host.user} with ${keyName.get(host.keyId) ?? ''}`)
    }
  }
  const detail: AuditDetail = {
    hosts: plan.hosts.map((host) => {
      const via = host.jump === null ? '' : ` via ${host.jump}`
      return `${host.alias}: ${host.hostname}:${String(host.port)}${via}`
    }),
    logins,
    guesses: plan.notes,
    dropped: plan.dropped,
  }
  await tx`INSERT INTO audit_event (at, actor, kind, subject_type, subject_id, summary, detail)
    VALUES (${at}, 'system', 'system.ssh_migrated', 'system', NULL,
      ${`Moved the ssh config into ${String(plan.hosts.length)} hosts and ${String(logins.length)} logins`},
      ${JSON.stringify(detail)})`
}
