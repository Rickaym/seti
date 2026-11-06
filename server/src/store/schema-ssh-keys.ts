import os from 'node:os'
import { DEFAULT_PROFILE_ID, type AuditDetail, type SshOption } from '@seti/shared'
import type { Db } from '../pg.js'

/** Each host logs in with its own user and key; credential sets bundle hosts instead of logins. */
export const SSH_HOST_KEYS = `
ALTER TABLE ssh_key ADD COLUMN IF NOT EXISTS path TEXT;
ALTER TABLE ssh_key ADD COLUMN IF NOT EXISTS updated_at TEXT;
UPDATE ssh_key SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE ssh_key ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE ssh_host ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE ssh_host ADD COLUMN IF NOT EXISTS key_id TEXT REFERENCES ssh_key(id);
CREATE INDEX IF NOT EXISTS ssh_host_key ON ssh_host(key_id);

CREATE TABLE IF NOT EXISTS credential_profile_ssh_host (
  profile_id TEXT NOT NULL REFERENCES credential_profile(id) ON DELETE CASCADE,
  host TEXT NOT NULL REFERENCES ssh_host(alias) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, host)
);
CREATE INDEX IF NOT EXISTS credential_profile_ssh_host_host ON credential_profile_ssh_host(host);
`

interface HostRow {
  alias: string
  hostname: string
  port: number
  jump: string | null
  options: SshOption[]
  created_at: string
}

interface LoginRow {
  profile_id: string
  host: string
  user: string
  key_id: string
}

interface NewHost {
  alias: string
  user: string
  key_id: string | null
  jump: string | null
  /** The host it was split from, or null for the host that keeps its alias. */
  from: string | null
}

type Logins = ReadonlyMap<string, ReadonlyMap<string, LoginRow>>

function chainOf(byAlias: ReadonlyMap<string, HostRow>, alias: string): string[] {
  const chain: string[] = []
  for (let host = byAlias.get(alias); host !== undefined && !chain.includes(host.alias);) {
    chain.push(host.alias)
    host = host.jump === null ? undefined : byAlias.get(host.jump)
  }
  return chain
}

/** Jump hosts before the hosts that jump through them. */
function jumpOrder(hosts: readonly HostRow[]): HostRow[] {
  const byAlias = new Map(hosts.map((host) => [host.alias, host]))
  const depth = (host: HostRow) => chainOf(byAlias, host.alias).length
  return [...hosts].sort((a, b) => (depth(a) === depth(b) ? a.alias.localeCompare(b.alias) : depth(a) - depth(b)))
}

/** What each agent could use under logins: hosts its access enables whose whole chain has a login. */
async function usableBefore(tx: Db, hosts: readonly HostRow[], logins: Logins): Promise<Map<string, string[]>> {
  const byAlias = new Map(hosts.map((host) => [host.alias, host]))
  const defaults = new Set(
    (await tx<{ item: string }[]>`SELECT item FROM access_default WHERE kind = 'ssh' AND enabled`).map((r) => r.item),
  )
  const choices = new Map<string, Map<string, boolean>>()
  for (const row of await tx<{ task_id: string; item: string; enabled: boolean }[]>`SELECT task_id, item, enabled
    FROM task_access WHERE kind = 'ssh'`) {
    choices.set(row.task_id, (choices.get(row.task_id) ?? new Map<string, boolean>()).set(row.item, row.enabled))
  }
  const usable = new Map<string, string[]>()
  for (const task of await tx<{ id: string; profile_id: string }[]>`SELECT id, profile_id FROM task`) {
    const own = choices.get(task.id)
    const mine = logins.get(task.profile_id)
    usable.set(
      task.id,
      hosts
        .filter((host) => own?.get(host.alias) ?? defaults.has(host.alias))
        .filter((host) => chainOf(byAlias, host.alias).every((hop) => mine?.has(hop) === true))
        .map((host) => host.alias),
    )
  }
  return usable
}

function freeAlias(taken: Set<string>, base: string, user: string): string {
  const candidates = [`${base}-${user}`, ...Array.from({ length: 98 }, (_, index) => `${base}-${String(index + 2)}`)]
  const alias = candidates.map((name) => name.slice(0, 253)).find((name) => !taken.has(name.toLowerCase()))
  if (alias === undefined) {
    throw new Error(`No free alias for a copy of the ssh host ${base}`)
  }
  taken.add(alias.toLowerCase())
  return alias
}

interface Plan {
  hosts: NewHost[]
  /** Per credential set, the alias each old host now goes by for it. */
  aliasFor: Map<string, Map<string, string>>
}

interface LoginGroup {
  login: LoginRow
  jump: string | null
  profiles: string[]
}

/** The distinct ways sets log in to a host, its jump host as each set reaches it included. */
function loginGroups(host: HostRow, logins: Logins, aliasFor: Plan['aliasFor']): LoginGroup[] {
  const groups = new Map<string, LoginGroup>()
  for (const [profile, mine] of [...logins].sort(([a], [b]) => a.localeCompare(b))) {
    const login = mine.get(host.alias)
    if (login === undefined) {
      continue
    }
    const jump = host.jump === null ? null : (aliasFor.get(profile)?.get(host.jump) ?? host.jump)
    const key = JSON.stringify([login.user, login.key_id, jump])
    const group = groups.get(key) ?? { login, jump, profiles: [] }
    group.profiles.push(profile)
    groups.set(key, group)
  }
  const rank = (group: LoginGroup) =>
    (group.profiles.includes(DEFAULT_PROFILE_ID) ? 1_000_000 : 0) + group.profiles.length
  return [...groups.values()].sort((a, b) => rank(b) - rank(a))
}

/**
 * Splits hosts whose sets log in differently: the login of Default, else of the most sets, keeps
 * the alias, and each other login becomes a copy of the host named after its user.
 */
function planHosts(hosts: readonly HostRow[], logins: Logins, fallbackUser: string): Plan {
  const taken = new Set(hosts.map((host) => host.alias.toLowerCase()))
  const aliasFor = new Map([...logins.keys()].map((profile) => [profile, new Map<string, string>()]))
  const planned: NewHost[] = []
  for (const host of jumpOrder(hosts)) {
    const ranked = loginGroups(host, logins, aliasFor)
    if (ranked.length === 0) {
      planned.push({ alias: host.alias, user: fallbackUser, key_id: null, jump: host.jump, from: null })
    }
    for (const [index, group] of ranked.entries()) {
      const alias = index === 0 ? host.alias : freeAlias(taken, host.alias, group.login.user)
      planned.push({
        alias,
        user: group.login.user,
        key_id: group.login.key_id,
        jump: group.jump,
        from: index === 0 ? null : host.alias,
      })
      group.profiles.forEach((profile) => aliasFor.get(profile)?.set(host.alias, alias))
    }
  }
  return { hosts: planned, aliasFor }
}

async function writeHosts(tx: Db, hosts: readonly HostRow[], plan: Plan): Promise<void> {
  const byAlias = new Map(hosts.map((host) => [host.alias, host]))
  const at = new Date().toISOString()
  for (const entry of plan.hosts) {
    const source = byAlias.get(entry.from ?? entry.alias)
    if (source === undefined) {
      continue
    }
    if (entry.from === null) {
      await tx`UPDATE ssh_host SET username = ${entry.user}, key_id = ${entry.key_id}, jump = ${entry.jump}
        WHERE alias = ${entry.alias}`
    } else {
      await tx`INSERT INTO ssh_host (alias, hostname, port, jump, options, username, key_id, created_at, updated_at)
        VALUES (${entry.alias}, ${source.hostname}, ${source.port}, ${entry.jump},
          ${tx.json(source.options.map((option) => ({ ...option })))}, ${entry.user}, ${entry.key_id}, ${at}, ${at})`
    }
  }
}

/** Gives each agent overrides that reach exactly the hosts it used before, by their new aliases. */
async function keepReach(tx: Db, plan: Plan, usable: ReadonlyMap<string, string[]>): Promise<void> {
  const defaults = new Set(
    (await tx<{ item: string }[]>`SELECT item FROM access_default WHERE kind = 'ssh' AND enabled`).map((r) => r.item),
  )
  const profiles = new Map(
    (await tx<{ id: string; profile_id: string }[]>`SELECT id, profile_id FROM task`).map((r) => [r.id, r.profile_id]),
  )
  for (const [task, before] of usable) {
    const aliases = plan.aliasFor.get(profiles.get(task) ?? '')
    const wanted = new Set(before.map((alias) => aliases?.get(alias) ?? alias))
    await tx`DELETE FROM task_access WHERE task_id = ${task} AND kind = 'ssh'`
    for (const host of plan.hosts) {
      const on = wanted.has(host.alias)
      if (on !== defaults.has(host.alias)) {
        await tx`INSERT INTO task_access (task_id, kind, item, enabled) VALUES (${task}, 'ssh', ${host.alias}, ${on})`
      }
    }
  }
}

function hostLine(host: NewHost, keys: ReadonlyMap<string, string>): string {
  if (host.key_id === null) {
    return `${host.alias}: no login yet`
  }
  const from = host.from === null ? '' : ` (from ${host.from})`
  return `${host.alias}: ${host.user} with ${keys.get(host.key_id) ?? host.key_id}${from}`
}

/** Moves each set's logins onto the hosts, splitting a host its sets log in to differently. */
export async function loginsToHosts(tx: Db): Promise<void> {
  const [table] = await tx<{ found: string | null }[]>`SELECT to_regclass('ssh_login')::text AS found`
  if ((table?.found ?? null) === null) {
    return
  }
  const hosts = await tx<HostRow[]>`SELECT alias, hostname, port, jump, options, created_at FROM ssh_host
    ORDER BY alias`
  const logins = new Map<string, Map<string, LoginRow>>()
  for (const row of await tx<LoginRow[]>`SELECT profile_id, host, username AS user, key_id FROM ssh_login
    ORDER BY profile_id, host`) {
    logins.set(row.profile_id, (logins.get(row.profile_id) ?? new Map<string, LoginRow>()).set(row.host, row))
  }
  const usable = await usableBefore(tx, hosts, logins)
  const plan = planHosts(hosts, logins, os.userInfo().username)
  await writeHosts(tx, hosts, plan)
  await keepReach(tx, plan, usable)
  await tx`ALTER TABLE ssh_host ALTER COLUMN username SET NOT NULL`
  await tx`DROP TABLE ssh_login`
  if (hosts.length === 0) {
    return
  }
  const keys = new Map(
    (await tx<{ id: string; name: string }[]>`SELECT id, name FROM ssh_key`).map((row) => [row.id, row.name]),
  )
  const split = plan.hosts.filter((host) => host.from !== null).length
  const added = split === 0 ? '' : `, adding ${String(split)} for sets that logged in differently`
  const summary = `Gave each of ${String(hosts.length)} ssh hosts its own user and key${added}`
  const detail: AuditDetail = { hosts: plan.hosts.map((host) => hostLine(host, keys)) }
  await tx`INSERT INTO audit_event (at, actor, kind, subject_type, subject_id, summary, detail)
    VALUES (${new Date().toISOString()}, 'system', 'system.ssh_migrated', 'system', NULL, ${summary},
      ${JSON.stringify(detail)})`
}
