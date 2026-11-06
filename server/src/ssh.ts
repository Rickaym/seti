import type { SshHost, SshHostValues, SshKey, SshKnownHost, SshOption, SshStatus } from '@seti/shared'
import { audit } from './audit.js'
import { HttpError } from './http.js'
import { reloadSshAgents } from './ssh-agent.js'
import { checkJump, firstHop, hostMap, knownName, sshRoute, SshHostError } from './ssh-config.js'
import { accessDefaults } from './store/access.js'
import { profiles } from './store/credentials.js'
import {
  setHosts,
  sshHostStore,
  sshKeys,
  sshKnownHosts,
  type KnownHostRow,
  type SetHostRow,
  type SshHostFacts,
  type SshHostRow,
  type SshKeyRow,
} from './store/ssh.js'
import { signalWorkspaces } from './workspace/dir.js'

const publicRow = ({ public_key: _key, ...row }: KnownHostRow): SshKnownHost => row

/** Something changed what agents reach: task.md files and the running agents' keys follow. */
export async function sshChanged(): Promise<void> {
  signalWorkspaces('task')
  await reloadSshAgents()
}

interface ViewContext {
  rows: ReadonlyMap<string, SshHostRow>
  defaults: Readonly<Record<string, boolean>>
  known: readonly KnownHostRow[]
  keys: ReadonlyMap<string, SshKeyRow>
  sets: readonly SetHostRow[]
}

function hostView(row: SshHostRow, context: ViewContext): SshHost {
  const name = knownName(row)
  const { rows } = context
  return {
    ...row,
    key_name: row.key_id === null ? null : (context.keys.get(row.key_id)?.name ?? null),
    default_enabled: context.defaults[row.alias] ?? false,
    route: sshRoute(rows, row.alias),
    first_hop: firstHop(rows, row.alias),
    known_name: name,
    host_keys: context.known.filter((entry) => entry.host.toLowerCase() === name).map(publicRow),
    jump_for: [...rows.values()].filter((other) => other.jump === row.alias).map((other) => other.alias),
    sets: context.sets
      .filter((entry) => entry.host === row.alias)
      .map((entry) => ({ id: entry.profile_id, name: entry.profile_name })),
  }
}

export const keyView = (key: SshKeyRow, hosts: readonly SshHostRow[]): SshKey => ({
  ...key,
  hosts: hosts.filter((host) => host.key_id === key.id).map((host) => host.alias),
})

/** Every host with its key, default, route, trusted keys and sets, and every key with its hosts. */
export async function sshStatus(): Promise<SshStatus> {
  const [list, defaults, known, keys, sets] = await Promise.all([
    sshHostStore.list(),
    accessDefaults.all('ssh'),
    sshKnownHosts.list(),
    sshKeys.list(),
    setHosts.list(),
  ])
  const context = { rows: hostMap(list), defaults, known, keys: new Map(keys.map((key) => [key.id, key])), sets }
  const names = new Set(list.map(knownName))
  return {
    hosts: list.map((row) => hostView(row, context)),
    keys: keys.map((key) => keyView(key, list)),
    other_host_keys: known.filter((entry) => !names.has(entry.host.toLowerCase())).map(publicRow),
  }
}

const optionLines = (options: readonly SshOption[]) => options.map((option) => `${option.name} ${option.value}`)

const optionsText = (options: readonly SshOption[]) => (options.length === 0 ? 'none' : optionLines(options).join(', '))

function hostDetail(alias: string, facts: SshHostFacts, key: string | null) {
  return {
    alias,
    hostname: facts.hostname,
    port: facts.port,
    user: facts.user,
    key,
    jump: facts.jump,
    options: optionLines(facts.options),
  }
}

function checked(fn: () => void): void {
  try {
    fn()
  } catch (e) {
    throw e instanceof SshHostError ? new HttpError(409, e.message) : e
  }
}

async function requireKey(id: string): Promise<SshKeyRow> {
  const key = await sshKeys.get(id)
  if (key === undefined) {
    throw new HttpError(400, 'No such ssh key')
  }
  return key
}

const factsOf = (fields: SshHostValues): SshHostFacts => ({
  hostname: fields.hostname,
  port: fields.port,
  user: fields.user,
  key_id: fields.key_id,
  jump: fields.jump,
  options: fields.options,
})

/** Forgets trusted keys of addresses no host uses any more; returns their names. */
async function forgetUnused(names: readonly string[]): Promise<string[]> {
  const used = new Set((await sshHostStore.list()).map(knownName))
  const gone = [...new Set(names)].filter((name) => !used.has(name))
  for (const name of gone) {
    await sshKnownHosts.deleteHost(name)
  }
  const known = new Set((await sshKnownHosts.list()).map((row) => row.host.toLowerCase()))
  return gone.filter((name) => !known.has(name))
}

export async function createSshHost(alias: string, fields: SshHostValues): Promise<SshStatus> {
  const facts = factsOf(fields)
  const rows = hostMap(await sshHostStore.list())
  if ([...rows.keys()].some((name) => name.toLowerCase() === alias.toLowerCase())) {
    throw new HttpError(409, `There is already an ssh host ${alias}`)
  }
  checked(() => {
    checkJump(rows, alias, facts.jump)
  })
  const key = await requireKey(fields.key_id)
  await sshHostStore.insert(alias, facts)
  await audit.record({
    actor: 'user',
    kind: 'system.ssh_host_created',
    subject_type: 'system',
    subject_id: `ssh:${alias}`,
    summary: `Added the ssh host ${alias}: ${facts.user} at ${facts.hostname}:${String(facts.port)} with ${key.name}`,
    detail: hostDetail(alias, facts, key.name),
  })
  await sshChanged()
  return sshStatus()
}

async function keyName(id: string | null): Promise<string> {
  return id === null ? 'none' : ((await sshKeys.get(id))?.name ?? id)
}

async function changesOf(before: SshHostRow, after: SshHostFacts): Promise<string[]> {
  const pairs: [string, string, string][] = [
    ['hostname', before.hostname, after.hostname],
    ['port', String(before.port), String(after.port)],
    ['user', before.user, after.user],
    ['key', await keyName(before.key_id), await keyName(after.key_id)],
    ['jump', before.jump ?? 'none', after.jump ?? 'none'],
    ['options', optionsText(before.options), optionsText(after.options)],
  ]
  return pairs.filter(([, from, to]) => from !== to).map(([what, from, to]) => `${what}: ${from} -> ${to}`)
}

export async function updateSshHost(alias: string, fields: SshHostValues): Promise<SshStatus> {
  const facts = factsOf(fields)
  const list = await sshHostStore.list()
  const before = list.find((row) => row.alias === alias)
  if (before === undefined) {
    throw new HttpError(404, `No ssh host ${alias}`)
  }
  checked(() => {
    checkJump(hostMap(list), alias, facts.jump)
  })
  const key = await requireKey(fields.key_id)
  const changes = await changesOf(before, facts)
  if (changes.length === 0) {
    return sshStatus()
  }
  await sshHostStore.update(alias, facts)
  const forgotten = await forgetUnused([knownName(before)])
  await audit.record({
    actor: 'user',
    kind: 'system.ssh_host_changed',
    subject_type: 'system',
    subject_id: `ssh:${alias}`,
    summary: `Changed the ssh host ${alias}: ${changes.join('; ')}`,
    detail: { ...hostDetail(alias, facts, key.name), changes, host_keys_forgotten: forgotten },
  })
  await sshChanged()
  return sshStatus()
}

/** Renames a host; its sets, the hosts jumping through it and agents' choices follow next turn. */
export async function renameSshHost(alias: string, next: string): Promise<SshStatus> {
  const list = await sshHostStore.list()
  if (!list.some((row) => row.alias === alias)) {
    throw new HttpError(404, `No ssh host ${alias}`)
  }
  if (next === alias) {
    return sshStatus()
  }
  if (list.some((row) => row.alias !== alias && row.alias.toLowerCase() === next.toLowerCase())) {
    throw new HttpError(409, `There is already an ssh host ${next}`)
  }
  const jumpers = list.filter((row) => row.jump === alias).map((row) => row.alias)
  const sets = await sshHostStore.rename(alias, next)
  await audit.record({
    actor: 'user',
    kind: 'system.ssh_host_renamed',
    subject_type: 'system',
    subject_id: `ssh:${next}`,
    summary: `Renamed the ssh host ${alias} to ${next}`,
    detail: { from: alias, to: next, sets, jump_for: jumpers },
  })
  await sshChanged()
  return sshStatus()
}

/** Deletes a host no other host jumps through, with its default, agents' choices and set entries. */
export async function deleteSshHost(alias: string): Promise<SshStatus> {
  const list = await sshHostStore.list()
  const host = list.find((row) => row.alias === alias)
  if (host === undefined) {
    throw new HttpError(404, `No ssh host ${alias}`)
  }
  const through = list.filter((row) => row.jump === alias).map((row) => row.alias)
  if (through.length > 0) {
    throw new HttpError(409, `${through.join(', ')} ${through.length === 1 ? 'jumps' : 'jump'} through ${alias}`)
  }
  const sets = await sshHostStore.delete(alias)
  const forgotten = await forgetUnused([knownName(host)])
  await audit.record({
    actor: 'user',
    kind: 'system.ssh_host_deleted',
    subject_type: 'system',
    subject_id: `ssh:${alias}`,
    summary: `Deleted the ssh host ${alias}`,
    detail: { alias, removed_from_sets: sets, host_keys_forgotten: forgotten },
  })
  await sshChanged()
  return sshStatus()
}

export const profileSshHosts = async (profileId: string): Promise<string[]> => setHosts.forProfile(profileId)

/** Bundles a host into a credential, or with false takes it out; its agents follow next turn. */
export async function setSetHost(profileId: string, alias: string, bundled: boolean): Promise<void> {
  const profile = await profiles.get(profileId)
  if (profile === undefined) {
    throw new HttpError(404, 'No such credential')
  }
  if ((await sshHostStore.get(alias)) === undefined) {
    throw new HttpError(404, `No ssh host ${alias}`)
  }
  const changed = bundled ? await setHosts.add(profileId, alias) : await setHosts.remove(profileId, alias)
  if (!changed) {
    return
  }
  await profiles.touch(profileId)
  await audit.record({
    actor: 'user',
    kind: 'system.profile_changed',
    subject_type: 'credential_profile',
    subject_id: profileId,
    summary: bundled
      ? `Every agent using ${profile.name} gets the ssh host ${alias}`
      : `Agents using ${profile.name} no longer get the ssh host ${alias} from it`,
    detail: { profile: profile.name, change: bundled ? 'ssh_host_added' : 'ssh_host_removed', host: alias },
  })
  await sshChanged()
}
