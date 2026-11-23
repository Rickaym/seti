import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SshKeySecretName } from '@seti/shared'
import type { SshPlan } from './launch-plan.js'
import { secret } from './secrets.js'
import { reachKeys, sandboxSshConfig, type RenderHost } from './ssh-config.js'
import { sshKeys, sshKnownHosts, type SshHostRow, type SshKeyRow } from './store/ssh.js'

export const keySecret = (id: string): SshKeySecretName => `ssh_key:${id}`

/** A key file's path with a leading ~/ taken as this user's home. */
export const keyFilePath = (file: string) => (file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file)

/** A key's private half: read from its file, or opened from the secret store. */
async function privateKeyOf(key: Pick<SshKeyRow, 'id' | 'source' | 'path'>): Promise<string | null> {
  if (key.source === 'file') {
    return key.path === null ? null : fs.promises.readFile(keyFilePath(key.path), 'utf8')
  }
  return secret(keySecret(key.id))
}

/** The trusted keys of these known_hosts names, so a change restarts the sessions that use them. */
export async function sshStamp(names: ReadonlySet<string>): Promise<string[]> {
  const rows = await sshKnownHosts.list()
  return rows.filter((row) => names.has(row.host.toLowerCase())).map((row) => `${row.host} ${row.fingerprint}`)
}

/** The private keys the hosts log in with; ones that will not open are skipped. */
export async function hostKeys(hosts: readonly SshHostRow[]): Promise<string[]> {
  const opened = await Promise.all(
    reachKeys(hosts).map(async (id) => {
      const key = await sshKeys.get(id)
      return key === undefined ? null : privateKeyOf(key).catch(() => null)
    }),
  )
  return opened.filter((key) => key !== null)
}

/** The fingerprints of the hosts' keys, so swapping a key restarts the sessions that use it. */
export async function keyStamp(hosts: readonly SshHostRow[]): Promise<string[]> {
  const keys = await sshKeys.list()
  const used = new Set(reachKeys(hosts))
  return keys.filter((key) => used.has(key.id)).map((key) => `${key.id} ${key.fingerprint}`)
}

/** The accepted host keys as known_hosts lines, only those of the named hosts. */
export async function knownHostsText(names: ReadonlySet<string>): Promise<string> {
  const rows = await sshKnownHosts.list()
  return rows
    .filter((row) => names.has(row.host.toLowerCase()))
    .map((row) => `${row.host} ${row.key_type} ${row.public_key}\n`)
    .join('')
}

const keyFileName = (keyId: string) => `seti-${keyId}.pub`

/** Writes these public keys by key id, which ssh needs to pick a key from the agent. */
function writePublicKeys(dir: string, keys: Readonly<Record<string, string>>): void {
  const wanted = new Set(Object.keys(keys).map(keyFileName))
  for (const file of fs.readdirSync(dir).filter((name) => /^seti-.*\.pub$/.test(name) && !wanted.has(name))) {
    fs.rmSync(path.join(dir, file), { force: true })
  }
  for (const [id, key] of Object.entries(keys)) {
    fs.writeFileSync(path.join(dir, keyFileName(id)), `${key}\n`, { mode: 0o644 })
  }
}

/** The public halves of the hosts' keys, by key id. */
export async function publicKeys(hosts: readonly SshHostRow[]): Promise<Record<string, string>> {
  const keys = await Promise.all(reachKeys(hosts).map(async (id) => sshKeys.get(id)))
  return Object.fromEntries(keys.flatMap((key) => (key === undefined ? [] : [[key.id, key.public_key]])))
}

/** Writes the public halves of the hosts' keys. */
export async function writeKeyFiles(dir: string, hosts: readonly SshHostRow[]): Promise<void> {
  writePublicKeys(dir, await publicKeys(hosts))
}

export const renderHosts = (hosts: readonly SshHostRow[], keyDir: string): RenderHost[] =>
  hosts.flatMap((host) =>
    host.key_id === null ? [] : [{ host, keyFile: path.join(keyDir, keyFileName(host.key_id)) }],
  )

/** Where a sandbox with ssh hosts finds its ssh config, known hosts and agent socket. */
export interface SandboxSsh {
  /** Mounted read-only at ~/.ssh inside. */
  dir: string
  /** Mounted read-only; holds only the task's agent socket. */
  agentDir: string
}

/** What a task's sandbox ssh is made of: where it lives, its proxy and its plan. */
export interface SandboxSshRequest {
  taskDir: string
  home: string
  proxy: { socat: string; port: number }
  plan: SshPlan
}

/** Writes a task's ssh files for its usable hosts; its agent, holding only their keys, is apart. */
export function prepareSandboxSsh(request: SandboxSshRequest): SandboxSsh {
  const { taskDir, home, proxy, plan } = request
  const dir = path.join(taskDir, 'ssh')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writePublicKeys(dir, plan.publicKeys)
  const inside = path.join(home, '.ssh')
  const config = sandboxSshConfig(renderHosts(plan.hosts, inside), {
    proxy,
    knownHosts: path.join(inside, 'known_hosts'),
  })
  fs.writeFileSync(path.join(dir, 'config'), config, { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'known_hosts'), plan.knownHosts, { mode: 0o644 })
  return { dir, agentDir: path.join(taskDir, 'ssh-agent') }
}
