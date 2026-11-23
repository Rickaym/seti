import fs from 'node:fs'
import path from 'node:path'
import type { SshPlan } from './launch-plan.js'
import { replaceFile } from './mcp-oauth.js'
import { sandboxSshConfig, type RenderHost } from './ssh-config.js'
import type { SshHostRow } from './store/ssh.js'

const keyFileName = (keyId: string) => `seti-${keyId}.pub`

/** Writes these public keys by key id, which ssh needs to pick a key from the agent. */
export function writePublicKeys(dir: string, keys: Readonly<Record<string, string>>): void {
  const wanted = new Set(Object.keys(keys).map(keyFileName))
  for (const file of fs.readdirSync(dir).filter((name) => /^seti-.*\.pub$/.test(name) && !wanted.has(name))) {
    fs.rmSync(path.join(dir, file), { force: true })
  }
  for (const [id, key] of Object.entries(keys)) {
    replaceFile(path.join(dir, keyFileName(id)), `${key}\n`, 0o644)
  }
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
  replaceFile(path.join(dir, 'config'), config, 0o600)
  replaceFile(path.join(dir, 'known_hosts'), plan.knownHosts, 0o644)
  return { dir, agentDir: path.join(taskDir, 'ssh-agent') }
}
