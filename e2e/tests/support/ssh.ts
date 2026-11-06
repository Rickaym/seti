import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import type { SshKey, SshStatus } from '@seti/shared'
import { paths } from './env.js'
import { apiData, expect } from './fixtures.js'

export const SSHD = '/usr/sbin/sshd'
const SSH_KEYGEN = '/usr/bin/ssh-keygen'

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** A throwaway sshd on loopback whose host key the page checks, letting in only `key`. */
export async function startSshd(dir: string, key: string): Promise<{ port: number; stop: () => void }> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  execFileSync(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'host')])
  fs.writeFileSync(path.join(dir, 'authorized_keys'), `${key}\n`)
  const port = await freePort()
  const config = [
    'ListenAddress 127.0.0.1',
    `Port ${String(port)}`,
    `HostKey ${path.join(dir, 'host')}`,
    `PidFile ${path.join(dir, 'pid')}`,
    `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`,
    'UsePAM no',
    'StrictModes no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
  ]
  fs.writeFileSync(path.join(dir, 'config'), `${config.join('\n')}\n`)
  const daemon = spawn(SSHD, ['-D', '-f', path.join(dir, 'config')], { stdio: 'ignore' })
  await expect
    .poll(async () => {
      const socket = net.connect(port, '127.0.0.1')
      const up = await new Promise<boolean>((resolve) => {
        socket.once('connect', () => {
          resolve(true)
        })
        socket.once('error', () => {
          resolve(false)
        })
      })
      socket.destroy()
      return up
    })
    .toBe(true)
  return {
    port,
    stop: () => {
      daemon.kill()
    },
  }
}

/** A fresh private key file under the e2e root, its public half removed. */
export function keyFile(name: string): string {
  const file = path.join(paths.root, `${name}-${randomUUID().slice(0, 8)}`)
  execFileSync(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', file])
  fs.rmSync(`${file}.pub`)
  return file
}

export async function addKey(request: APIRequestContext, name: string): Promise<SshKey> {
  const res = await request.post('/api/ssh/keys', { data: { name } })
  return ((await res.json()) as { data: SshKey }).data
}

export async function addHost(request: APIRequestContext, alias: string, hostname: string, extra: object) {
  expect((await request.post('/api/ssh/hosts', { data: { alias, hostname, user: 'ops', ...extra } })).ok()).toBe(true)
}

/** Deletes every host, jump hosts last, then every key and trusted host key left. */
export async function clearSsh(request: APIRequestContext): Promise<void> {
  const status = await apiData<SshStatus>(request, '/ssh')
  const hosts = [...status.hosts]
  while (hosts.length > 0) {
    const leaf = hosts.findIndex((host) => !hosts.some((other) => other.jump === host.alias))
    const [host] = hosts.splice(Math.max(leaf, 0), 1)
    await request.delete(`/api/ssh/hosts/${host?.alias ?? ''}`)
  }
  for (const key of status.keys) {
    await request.delete(`/api/ssh/keys/${key.id}`)
  }
  for (const entry of status.other_host_keys) {
    await request.delete(`/api/ssh/known-hosts?host=${encodeURIComponent(entry.host)}`)
  }
}
