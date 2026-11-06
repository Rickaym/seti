import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SshKey, SshStatus } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { findBinary } from '../binaries.js'
import { sql } from '../db.js'
import { secret } from '../secrets.js'
import { stopSshAgents } from '../ssh-agent.js'
import { hostKeys, keyStamp } from '../ssh-files.js'
import { auditEvents } from '../store/audit.js'
import { sshHostStore } from '../store/ssh.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'

const app = createApp()
const LOCAL = { host: '127.0.0.1:3006', ...USER_AUTH, origin: 'http://127.0.0.1:3006' }
const EA = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...EA_AUTH }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-ssh-routes-'))

afterAll(async () => {
  await stopSshAgents()
  fs.rmSync(scratch, { recursive: true, force: true })
})

async function send(method: string, url: string, body?: unknown, headers: Record<string, string> = LOCAL) {
  return app.request(`/api${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

let ops: SshKey

beforeAll(async () => {
  ops = await data<SshKey>(await send('POST', '/ssh/keys', { name: 'ops' }))
})

const fields = (hostname: string, extra: Record<string, unknown> = {}) => ({
  hostname,
  user: 'ops',
  key_id: ops.id,
  ...extra,
})

const host = (alias: string, hostname: string, extra: Record<string, unknown> = {}) => ({
  alias,
  ...fields(hostname, extra),
})

function keyFile(name: string): string {
  const file = path.join(scratch, name)
  execFileSync(findBinary('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-f', file])
  return file
}

describe('ssh settings', () => {
  it('adds hosts with a user, a key and a jump host, lists their routes and audits each change', async () => {
    await data<SshStatus>(await send('POST', '/ssh/hosts', host('jump', '203.0.113.9', { port: 2222 })))
    const status = await data<SshStatus>(
      await send(
        'POST',
        '/ssh/hosts',
        host('k8s', '192.0.2.9', { jump: 'jump', options: [{ name: 'connecttimeout', value: '5' }] }),
      ),
    )
    expect(status.hosts.map((entry) => [entry.alias, entry.route, entry.first_hop, entry.jump_for])).toEqual([
      ['jump', '203.0.113.9:2222', '203.0.113.9:2222', ['k8s']],
      ['k8s', '192.0.2.9:22 via jump', '203.0.113.9:2222', []],
    ])
    expect(status.hosts[1]).toMatchObject({
      options: [{ name: 'ConnectTimeout', value: '5' }],
      user: 'ops',
      key_id: ops.id,
      key_name: 'ops',
      sets: [],
    })
    expect(status.keys.find((key) => key.id === ops.id)?.hosts).toEqual(['jump', 'k8s'])
    expect(await auditEvents.latest('system.ssh_host_created')).toMatchObject({
      summary: 'Added the ssh host k8s: ops at 192.0.2.9:22 with ops',
      detail: { alias: 'k8s', user: 'ops', key: 'ops', jump: 'jump', options: ['ConnectTimeout 5'] },
    })
    const changed = await data<SshStatus>(
      await send('PUT', '/ssh/hosts/k8s', fields('192.0.2.10', { user: 'ubuntu', jump: 'jump' })),
    )
    expect(changed.hosts[1]).toMatchObject({ hostname: '192.0.2.10', user: 'ubuntu', options: [] })
    expect((await auditEvents.latest('system.ssh_host_changed'))?.detail).toMatchObject({
      changes: ['hostname: 192.0.2.9 -> 192.0.2.10', 'user: ops -> ubuntu', 'options: ConnectTimeout 5 -> none'],
    })
  })

  it('refuses unsafe options, loops, unknown jump hosts or keys and duplicates, keeping the hosts', async () => {
    const unsafe = await send(
      'POST',
      '/ssh/hosts',
      host('evil', '203.0.113.5', { options: [{ name: 'ProxyCommand', value: 'sh' }] }),
    )
    expect(unsafe.status).toBe(400)
    expect(await unsafe.text()).toContain('ProxyCommand is not allowed: it runs commands on this machine')
    const loop = await send('PUT', '/ssh/hosts/jump', fields('203.0.113.9', { jump: 'k8s' }))
    expect(loop.status).toBe(409)
    expect(await loop.text()).toContain('k8s already connects through jump')
    expect((await send('POST', '/ssh/hosts', host('lost', '203.0.113.6', { jump: 'nowhere' }))).status).toBe(409)
    expect((await send('POST', '/ssh/hosts', host('K8S', '203.0.113.7'))).status).toBe(409)
    expect((await send('POST', '/ssh/hosts', host('bad alias', '203.0.113.7'))).status).toBe(400)
    expect((await send('POST', '/ssh/hosts', host('nokey', '203.0.113.7', { key_id: 'nope' }))).status).toBe(400)
    expect((await send('POST', '/ssh/hosts', host('nouser', '203.0.113.7', { user: 'r t' }))).status).toBe(400)
    const status = await data<SshStatus>(await send('GET', '/ssh'))
    expect(status.hosts.map((entry) => entry.alias)).toEqual(['jump', 'k8s'])
  })

  it('renames a host with its sets, its default and the hosts jumping through it, refusing a clash', async () => {
    await data(await send('PUT', '/credentials/profiles/default/ssh-hosts/jump', {}))
    await sql`INSERT INTO access_default (kind, item, enabled, updated_at)
      VALUES ('ssh', 'jump', true, ${new Date().toISOString()})`
    const clash = await send('POST', '/ssh/hosts/jump/rename', { alias: 'K8S' })
    expect(clash.status).toBe(409)
    expect(await clash.text()).toContain('There is already an ssh host K8S')
    expect((await send('POST', '/ssh/hosts/nowhere/rename', { alias: 'gone' })).status).toBe(404)
    expect((await send('POST', '/ssh/hosts/jump/rename', { alias: 'bad alias' })).status).toBe(400)

    const status = await data<SshStatus>(await send('POST', '/ssh/hosts/jump/rename', { alias: 'bastion' }))
    const view = status.hosts.map((entry) => ({
      alias: entry.alias,
      jump: entry.jump,
      route: entry.route,
      on: entry.default_enabled,
      sets: entry.sets.map((set) => set.name),
    }))
    expect(view).toEqual([
      { alias: 'bastion', jump: null, route: '203.0.113.9:2222', on: true, sets: ['Default'] },
      { alias: 'k8s', jump: 'bastion', route: '192.0.2.10:22 via bastion', on: false, sets: [] },
    ])
    expect(await auditEvents.latest('system.ssh_host_renamed')).toMatchObject({
      summary: 'Renamed the ssh host jump to bastion',
      detail: { from: 'jump', to: 'bastion', sets: ['Default'], jump_for: ['k8s'] },
    })

    await data(await send('POST', '/ssh/hosts/bastion/rename', { alias: 'jump' }))
    await data(await send('DELETE', '/credentials/profiles/default/ssh-hosts/jump'))
    await sql`DELETE FROM access_default WHERE kind = 'ssh' AND item = 'jump'`
    expect((await sshHostStore.list()).map((row) => [row.alias, row.jump])).toEqual([
      ['jump', null],
      ['k8s', 'jump'],
    ])
  })

  it('saves no host without a key and checks none until it and its jump hosts have one', async () => {
    const keyless = { hostname: '203.0.113.40', user: 'ops' }
    const unsaved = await send('POST', '/ssh/hosts', { alias: 'bare', ...keyless })
    expect(unsaved.status).toBe(400)
    expect(await unsaved.text()).toContain('Choose a key')
    const carried = { hostname: '203.0.113.40', port: 22, user: 'ops', key_id: null, jump: null, options: [] }
    await sshHostStore.insert('bare', carried)
    await sshHostStore.insert('behind', { ...carried, hostname: '203.0.113.41', key_id: ops.id, jump: 'bare' })
    const kept = await send('PUT', '/ssh/hosts/bare', keyless)
    expect(kept.status).toBe(400)
    expect(await kept.text()).toContain('Choose a key')

    const bare = await send('POST', '/ssh/hosts/bare/check', {})
    expect(bare.status).toBe(409)
    expect(await bare.text()).toContain('Choose a key for bare before checking bare')
    const behind = await send('POST', '/ssh/hosts/behind/check', {})
    expect(behind.status).toBe(409)
    expect(await behind.text()).toContain('Choose a key for its jump host bare before checking behind')
    expect((await send('POST', '/ssh/hosts/nowhere/check', {})).status).toBe(404)
    await data(await send('DELETE', '/ssh/hosts/behind'))
    await data(await send('DELETE', '/ssh/hosts/bare'))
  })

  it('refuses to delete a key or jump host in use', async () => {
    const inUse = await send('DELETE', `/ssh/keys/${ops.id}`)
    expect(inUse.status).toBe(409)
    expect(await inUse.text()).toContain('jump, k8s use ops; choose another key there first')
    const jump = await send('DELETE', '/ssh/hosts/jump')
    expect(jump.status).toBe(409)
    expect(await jump.text()).toContain('k8s jumps through jump')

    await data(await send('PUT', '/credentials/profiles/default/ssh-hosts/k8s', {}))
    const removed = await data<SshStatus>(await send('DELETE', '/ssh/hosts/k8s'))
    expect(removed.hosts.map((entry) => entry.alias)).toEqual(['jump'])
    expect((await auditEvents.latest('system.ssh_host_deleted'))?.detail).toMatchObject({
      removed_from_sets: ['Default'],
    })
    await data(await send('DELETE', '/ssh/hosts/jump'))
  })

  it('swaps a key once and every host that uses it logs in with the new one', async () => {
    const shared = await data<SshKey>(await send('POST', '/ssh/keys', { name: 'shared' }))
    await data(await send('POST', '/ssh/hosts', host('one', '203.0.113.21', { key_id: shared.id })))
    await data(await send('POST', '/ssh/hosts', host('two', '203.0.113.22', { key_id: shared.id })))
    const hosts = async () => (await sshHostStore.list()).filter((row) => ['one', 'two'].includes(row.alias))
    const before = { keys: await hostKeys(await hosts()), stamp: await keyStamp(await hosts()) }
    expect(before.keys).toHaveLength(1)

    const pasted = fs.readFileSync(keyFile('swap'), 'utf8')
    const swapped = await data<SshKey>(
      await send('PATCH', `/ssh/keys/${shared.id}`, { name: 'shared v2', private_key: pasted }),
    )
    expect(swapped).toMatchObject({ id: shared.id, name: 'shared v2', source: 'imported', hosts: ['one', 'two'] })
    expect(swapped.fingerprint).not.toBe(shared.fingerprint)
    expect(await hostKeys(await hosts())).toEqual([pasted])
    expect(await keyStamp(await hosts())).not.toEqual(before.stamp)
    const status = await data<SshStatus>(await send('GET', '/ssh'))
    expect(status.hosts.filter((entry) => entry.key_id === shared.id).map((entry) => entry.key_name)).toEqual([
      'shared v2',
      'shared v2',
    ])
    const event = await auditEvents.latest('system.ssh_key_changed')
    expect(event).toMatchObject({ detail: { name: 'shared v2', hosts: ['one', 'two'] } })
    expect(JSON.stringify(event)).not.toContain('PRIVATE KEY')

    const file = keyFile('on-disk')
    const fromFile = await data<SshKey>(await send('PATCH', `/ssh/keys/${shared.id}`, { path: file }))
    expect(fromFile).toMatchObject({ source: 'file', path: file })
    expect(await secret(`ssh_key:${shared.id}`)).toBeNull()
    expect(await hostKeys(await hosts())).toEqual([fs.readFileSync(file, 'utf8')])
    expect((await send('PATCH', `/ssh/keys/${shared.id}`, { path: path.join(scratch, 'missing') })).status).toBe(400)
    expect((await send('PATCH', `/ssh/keys/${ops.id}`, { path: file })).status).toBe(409)

    await data(await send('DELETE', '/ssh/hosts/one'))
    await data(await send('DELETE', '/ssh/hosts/two'))
    await data(await send('DELETE', `/ssh/keys/${shared.id}`))
  })

  it('adds a key from a file on this machine and reads it only when an agent needs it', async () => {
    const file = keyFile('referenced')
    const key = await data<SshKey>(await send('POST', '/ssh/keys/file', { name: 'from disk', path: file }))
    expect(key).toMatchObject({ name: 'from disk', source: 'file', path: file, hosts: [] })
    const [type, base64] = fs.readFileSync(`${file}.pub`, 'utf8').split(' ')
    expect(key.public_key).toBe(`${type ?? ''} ${base64 ?? ''} from disk`)
    expect(await secret(`ssh_key:${key.id}`)).toBeNull()
    expect(await auditEvents.latest('system.ssh_key_added')).toMatchObject({
      summary: `Added from ${file} the ssh key from disk`,
    })
    expect((await send('POST', '/ssh/keys/file', { name: 'relative', path: 'id_ed25519' })).status).toBe(400)
    expect((await send('POST', '/ssh/keys/file', { name: 'gone', path: '/nonexistent/key' })).status).toBe(400)
    await data(await send('DELETE', `/ssh/keys/${key.id}`))
  })

  it('generates and imports keys, returning only public halves, and audits without key material', async () => {
    const texts: string[] = []
    const generated = await send('POST', '/ssh/keys', { name: 'seti main' })
    texts.push(await generated.clone().text())
    const key = await data<SshKey>(generated)
    expect(key).toMatchObject({ name: 'seti main', type: 'ssh-ed25519', source: 'generated', path: null })
    expect(key.public_key).toMatch(/^ssh-ed25519 \S+ seti main$/)
    const sealed = await secret(`ssh_key:${key.id}`)
    expect(sealed).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/)
    const name = `ssh_key:${key.id}`
    const [row] = await sql<{ sealed: string }[]>`SELECT sealed FROM secret WHERE name = ${name}`
    expect(row?.sealed).not.toContain('PRIVATE KEY')

    const privateKey = fs.readFileSync(keyFile('old'), 'utf8')
    const imported = await send('POST', '/ssh/keys/import', {
      name: 'old laptop',
      comment: 'ada@laptop',
      private_key: privateKey,
    })
    texts.push(await imported.clone().text())
    const importedKey = await data<SshKey>(imported)
    expect(importedKey.source).toBe('imported')
    expect(importedKey.public_key).toMatch(/^ssh-ed25519 \S+ ada@laptop$/)
    const commented = await data<SshKey>(await send('POST', '/ssh/keys', { name: 'ops two', comment: 'ops@k8s' }))
    expect(commented.public_key).toMatch(/^ssh-ed25519 \S+ ops@k8s$/)
    expect((await send('POST', '/ssh/keys', { name: 'bad', comment: 'two\nlines' })).status).toBe(400)
    expect((await send('POST', '/ssh/keys/import', { name: 'again', private_key: privateKey })).status).toBe(409)
    const bad = await send('POST', '/ssh/keys/import', { name: 'bad', private_key: `${privateKey.slice(0, 120)}x` })
    expect(bad.status).toBe(400)
    texts.push(await bad.text())

    texts.push(await (await send('GET', '/ssh')).text())
    texts.push(JSON.stringify(await auditEvents.latest('system.ssh_key_added')))
    const secretLines = [privateKey.split('\n')[1] ?? 'none', sealed?.split('\n')[1] ?? 'none']
    for (const text of texts) {
      expect(text).not.toContain('PRIVATE KEY')
      for (const line of secretLines) {
        expect(text).not.toContain(line)
      }
    }

    expect((await send('DELETE', `/ssh/keys/${key.id}`)).status).toBe(200)
    expect(await secret(`ssh_key:${key.id}`)).toBeNull()
    expect(await auditEvents.latest('system.ssh_key_removed')).toMatchObject({
      summary: 'Removed the ssh key seti main',
    })
  })

  it('accepts and forgets host keys, checking each line', async () => {
    const file = keyFile('host')
    const [type, key] = fs.readFileSync(`${file}.pub`, 'utf8').split(' ')
    const line = `203.0.113.9 ${type ?? ''} ${key ?? ''}`
    await data(await send('POST', '/ssh/hosts', host('box', '203.0.113.9')))
    const status = await data<SshStatus>(await send('POST', '/ssh/known-hosts', { lines: [line] }))
    expect(status.hosts.find((entry) => entry.alias === 'box')?.host_keys).toEqual([
      {
        host: '203.0.113.9',
        key_type: 'ssh-ed25519',
        fingerprint: expect.stringMatching(/^SHA256:/) as string,
        accepted_at: expect.any(String) as string,
      },
    ])
    expect((await send('POST', '/ssh/known-hosts', { lines: ['203.0.113.9 ssh-ed25519 !!'] })).status).toBe(400)
    expect((await send('POST', '/ssh/known-hosts', { lines: ['bad host ssh-ed25519 AAAA'] })).status).toBe(400)
    const cleared = await data<SshStatus>(await send('DELETE', '/ssh/known-hosts?host=203.0.113.9'))
    expect(cleared.hosts.find((entry) => entry.alias === 'box')?.host_keys).toEqual([])
    expect(await auditEvents.latest('system.ssh_host_removed')).toMatchObject({ detail: { host: '203.0.113.9' } })
    await data(await send('POST', '/ssh/known-hosts', { lines: [line] }))
    const gone = await data<SshStatus>(await send('DELETE', '/ssh/hosts/box'))
    expect(gone.other_host_keys).toEqual([])
    expect((await auditEvents.latest('system.ssh_host_deleted'))?.detail).toMatchObject({
      host_keys_forgotten: ['203.0.113.9'],
    })
  })

  it('lets the EA view hosts and the sets bundling them but change none of them', async () => {
    const key = await data<SshKey>(await send('POST', '/ssh/keys', { name: 'ea view' }))
    await data(await send('POST', '/ssh/hosts', host('seen', '203.0.113.8', { key_id: key.id })))
    await data(await send('PUT', '/credentials/profiles/default/ssh-hosts/seen', {}))
    const viewed = await send('GET', '/ssh', undefined, EA)
    const text = await viewed.clone().text()
    expect(await data<SshStatus>(viewed)).toMatchObject({
      hosts: [{ alias: 'seen', user: 'ops', key_name: 'ea view', sets: [{ id: 'default', name: 'Default' }] }],
      keys: [],
    })
    expect(text).not.toContain(key.public_key.split(' ')[1] ?? 'none')
    await send('DELETE', '/ssh/hosts/seen')
    await send('DELETE', `/ssh/keys/${key.id}`)
    const refusals = [
      await send('POST', '/ssh/keys', { name: 'ea' }, EA),
      await send('POST', '/ssh/keys/file', { name: 'ea', path: '/etc/ssh/ssh_host_ed25519_key' }, EA),
      await send('PATCH', `/ssh/keys/${ops.id}`, { name: 'ea' }, EA),
      await send('POST', '/ssh/hosts', host('ea', '203.0.113.8'), EA),
      await send('PUT', '/ssh/hosts/ea', fields('203.0.113.8'), EA),
      await send('DELETE', '/ssh/hosts/ea', undefined, EA),
      await send('POST', '/ssh/hosts/ea/rename', { alias: 'ea2' }, EA),
      await send('POST', '/ssh/hosts/ea/check', {}, EA),
      await send('POST', '/ssh/known-hosts', { lines: ['203.0.113.8 ssh-ed25519 AAAA'] }, EA),
      await send('DELETE', '/ssh/known-hosts?host=203.0.113.8', undefined, EA),
      await send('PUT', '/credentials/profiles/default/ssh-hosts/ea', {}, EA),
      await send('DELETE', '/credentials/profiles/default/ssh-hosts/ea', undefined, EA),
    ]
    expect(refusals.map((res) => res.status)).toEqual(refusals.map(() => 403))
    expect(await refusals[3]?.text()).toContain('The EA cannot change ssh hosts, keys or trusted host keys')
  })
})
