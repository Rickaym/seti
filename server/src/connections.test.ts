import { generateKeyPairSync } from 'node:crypto'
import type { Connection, CredentialProfile, MintTest, Task } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import {
  auditBlockedKey,
  connectionContext,
  connectionPlaceholders,
  connectionRules,
  taskConnections,
} from './connection-egress.js'
import { createConnectionPlaceholder } from './connections.js'
import { sql, tasks } from './db.js'
import { createPoller } from './pollers/actions.js'
import { sandboxPrompt } from './sandbox-prompt.js'
import { setupKey } from './session-options.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { clearConnections } from './test-connections.js'

const app = createApp()
const LOCAL = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006' }
const KEY = ['live', 'vendor', 'key', 'Zq81'].join('-')
const CLIENT_SECRET = ['entra', 'client', 'secret', 'Xk40'].join('-')
const MINTED = ['eyJ0', 'minted', 'access', 'token'].join('.')

/** Every response body the tests saw, to check no value or token ever leaves. */
const seen: string[] = []

async function send(method: string, url: string, body?: unknown, auth: Record<string, string> = USER_AUTH) {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { ...LOCAL, ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  seen.push(text)
  return { status: res.status, text }
}

async function data<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await send(method, url, body)
  expect(res.status, res.text).toBe(200)
  return (JSON.parse(res.text) as { data: T }).data
}

let count = 0
async function newTask(profileId = 'default'): Promise<Task> {
  const id = `connection-task-${String(++count)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [], profile_id: profileId })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('Task was not stored')
  }
  return task
}

const vendor = (extra: Record<string, unknown> = {}) => ({
  name: 'vendor',
  kind: 'key',
  env: 'VENDOR_KEY',
  hosts: ['api.vendor.test', '*.vendor-cdn.test'],
  ...extra,
})

const graph = {
  name: 'graph',
  kind: 'client_credentials',
  env: 'GRAPH_TOKEN',
  hosts: ['graph.vendor.test'],
  header: { name: 'Authorization', template: 'Bearer {{value}}' },
  mint: {
    token_url: 'https://login.vendor.test/tenant/oauth2/v2.0/token',
    client_id: 'app-id',
    scope: 'https://graph.vendor.test/.default',
  },
}

const expectNoValues = () => {
  for (const text of seen) {
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(CLIENT_SECRET)
    expect(text).not.toContain(MINTED)
  }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await sql`DELETE FROM channel`
  await sql`UPDATE task SET profile_id = 'default'`
  await sql`DELETE FROM credential_profile WHERE id <> 'default'`
  await clearConnections()
})

describe('connections', () => {
  it('adds a key with its value and credentials in one step, and never shows the value', async () => {
    const work = await data<CredentialProfile>('POST', '/credentials/profiles', { name: 'Work' })
    const added = await data<Connection>('POST', '/connections', {
      ...vendor(),
      values: { value: KEY },
      profile_ids: ['default', work.id],
    })
    expect(added).toMatchObject({
      name: 'vendor',
      env: 'VENDOR_KEY',
      slots: [{ slot: 'value', set: true }],
      missing: [],
      profiles: [
        { id: 'default', name: 'Default' },
        { id: work.id, name: 'Work' },
      ],
    })
    expect(added).not.toHaveProperty('placeholder')
    const listed = await data<CredentialProfile>('PATCH', `/credentials/profiles/${work.id}`, { name: 'Work' })
    expect(listed.connections).toEqual([
      { id: added.id, name: 'vendor', env: 'VENDOR_KEY', hosts: ['api.vendor.test', '*.vendor-cdn.test'] },
    ])
    expect(await auditEvents.latest('system.connection_created')).toMatchObject({
      actor: 'user',
      subject_type: 'connection',
      detail: { connection: 'vendor', env: 'VENDOR_KEY', credentials: ['Default', 'Work'], values: ['value'] },
    })
    const task = await newTask(work.id)
    const [placeholder] = connectionPlaceholders(await taskConnections(task))
    expect(placeholder?.placeholder).toMatch(/^seti-secret-vendor-[0-9a-f]{32}$/)
    expect(await placeholder?.value()).toBe(KEY)
    expect(await connectionContext(task.id)).toContain('VENDOR_KEY (api.vendor.test, *.vendor-cdn.test)')
    await auditBlockedKey(task, 'evil.test', ['vendor'])
    expect(JSON.stringify(await auditEvents.latest('task.api_key_blocked'))).not.toContain(KEY)
    await send('GET', '/audit?limit=50')
    expectNoValues()
  })

  it("adds a header on each agent's own credential's hosts and restarts agents when it changes", async () => {
    const a = await data<CredentialProfile>('POST', '/credentials/profiles', { name: 'A' })
    const header = { name: 'X-Api-Key', template: '{{value}}' }
    const made = await data<Connection>('POST', '/connections', {
      ...vendor({ header }),
      values: { value: KEY },
      profile_ids: [a.id],
    })
    const task = await newTask(a.id)
    const plain = await newTask()
    const url = new URL('https://api.vendor.test/v1/things')
    const valueOf = async (target: Task) => connectionRules(await taskConnections(target))[0]?.value(url) ?? null
    expect(await valueOf(task)).toBe(KEY)
    expect(await valueOf(plain)).toBeNull()
    expect(await sandboxPrompt(task.id)).toContain('signs requests to api.vendor.test, *.vendor-cdn.test')

    const before = await setupKey(task)
    await data('PUT', `/connections/${made.id}`, vendor({ header, hosts: ['api.vendor.test'] }))
    const changed = await setupKey(task)
    expect(changed).not.toBe(before)
    await data('PUT', `/connections/${made.id}/credentials`, { profile_ids: [] })
    expect(await setupKey(task)).not.toBe(changed)
    expect(await valueOf(task)).toBeNull()
    expect(await auditEvents.latest('system.connection_changed')).toMatchObject({
      detail: { change: 'credentials', credentials: [], removed: ['A'] },
    })
  })

  it('mints a test token, reports what it grants and records a failure, never the token', async () => {
    const made = await data<Connection>('POST', '/connections', { ...graph, values: { client_secret: CLIENT_SECRET } })
    expect(made.missing).toEqual([])
    const answers = [
      new Response(
        JSON.stringify({ access_token: MINTED, expires_in: 3600, scope: 'Mail.Read', token_type: 'Bearer' }),
      ),
      new Response(JSON.stringify({ error: 'invalid_client', error_description: `bad ${CLIENT_SECRET}` }), {
        status: 401,
      }),
    ]
    const posted: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      posted.push(typeof init?.body === 'string' ? init.body : '')
      return Promise.resolve(answers.shift() ?? new Response('{}', { status: 500 }))
    })
    const ok = await data<MintTest>('POST', `/connections/${made.id}/test`, {})
    expect(ok).toMatchObject({ ok: true, error: null, scope: 'Mail.Read', token_type: 'Bearer' })
    expect(posted[0]).toContain(`client_secret=${CLIENT_SECRET}`)
    const failed = await data<MintTest>('POST', `/connections/${made.id}/test`, {})
    expect(failed.error).toBe('the token endpoint answered 401 (invalid_client: bad [redacted])')
    expect((await data<Connection>('GET', `/connections/${made.id}`)).mint_error).toBe(failed.error)
    await send('GET', '/audit?limit=100')
    expectNoValues()
  })

  it('takes values write-only per slot and says what is missing, not as an error', async () => {
    const made = await data<Connection>('POST', '/connections', graph)
    expect(made.missing).toEqual(['client_secret'])
    const set = await data<Connection>('PUT', `/connections/${made.id}/values/client_secret`, { value: CLIENT_SECRET })
    expect(set.missing).toEqual([])
    expect((await send('PUT', `/connections/${made.id}/values/value`, { value: KEY })).status).toBe(400)
    const cleared = await data<Connection>('DELETE', `/connections/${made.id}/values/client_secret`)
    expect(cleared.missing).toEqual(['client_secret'])
    expect(await auditEvents.latest('system.secret_cleared')).toMatchObject({
      subject_type: 'connection',
      detail: { connection: 'graph', slot: 'client_secret' },
    })
    expectNoValues()
  })

  it('refuses reserved hosts and variables, taken names, broken headers and plain token URLs', async () => {
    await data('POST', '/connections', vendor())
    for (const bad of [
      vendor({ name: 'other', env: 'OTHER', hosts: ['api.github.com'] }),
      vendor({ name: 'other', env: 'OTHER', hosts: ['*.anthropic.com'] }),
      vendor({ name: 'other', env: 'GH_TOKEN' }),
      vendor({ name: 'other', env: 'AWS_SECRET_ACCESS_KEY' }),
      vendor({ name: 'other', env: 'OTHER', header: { name: 'Host', template: '{{value}}' } }),
      vendor({ name: 'other', env: 'OTHER', header: { name: 'X-Key', template: 'Bearer' } }),
      { ...graph, mint: { ...graph.mint, token_url: 'http://login.vendor.test/token' } },
    ]) {
      expect((await send('POST', '/connections', bad)).status).toBe(400)
    }
    expect((await send('POST', '/connections', vendor({ env: 'OTHER' }))).status).toBe(409)
    expect((await send('POST', '/connections', vendor({ name: 'other' }))).status).toBe(409)
    expect(
      (await send('POST', '/connections', { ...vendor({ name: 'other', env: 'OTHER' }), profile_ids: ['x'] })).status,
    ).toBe(404)
  })

  it('keeps a name pollers send and refuses to delete it until they change', async () => {
    const made = await data<Connection>('POST', '/connections', { ...vendor(), values: { value: KEY } })
    await createPoller({
      name: 'Vendor feed',
      script: 'export default () => []',
      preset: 'blank',
      interval_s: 300,
      timeout_s: 30,
      extra_hosts: [],
      secrets: ['vendor'],
      fingerprint_fields: [],
      detect_gone: false,
      enabled: false,
      subscribe_ea: false,
    })
    expect((await data<Connection>('GET', `/connections/${made.id}`)).pollers).toEqual(['Vendor feed'])
    expect((await send('PUT', `/connections/${made.id}`, vendor({ name: 'renamed' }))).status).toBe(409)
    expect((await send('DELETE', `/connections/${made.id}`)).status).toBe(409)
    await sql`DELETE FROM channel`
    expect((await send('DELETE', `/connections/${made.id}`)).status).toBe(204)
    const prefix = `connection:${made.id}`
    expect(await sql`SELECT name FROM secret WHERE starts_with(name, ${prefix})`).toHaveLength(0)
  })

  it('makes a connection an approved request asked for, with no value and in no credential', async () => {
    const made = await createConnectionPlaceholder(
      { name: 'ci_token', hosts: ['ci.vendor.test'], adds_header: true },
      'agent',
    )
    expect(made).toMatchObject({
      env: 'CI_TOKEN',
      header: { name: 'Authorization', template: 'Bearer {{value}}' },
      missing: ['value'],
      profiles: [],
    })
    expect(await auditEvents.latest('system.connection_created')).toMatchObject({ actor: 'agent' })
    const again = await createConnectionPlaceholder(
      { name: 'ci', hosts: ['ci.vendor.test'], adds_header: false },
      'agent',
    )
    expect(again.env).toBe('CI')
  })

  it('takes a Google key file only when Seti can sign with it, never echoing it', async () => {
    const google = {
      name: 'gdrive',
      kind: 'jwt_bearer',
      env: 'GDRIVE_TOKEN',
      hosts: ['*.googleapis.com'],
      header: { name: 'Authorization', template: 'Bearer {{value}}' },
      mint: { token_url: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/drive' },
    }
    const broken = JSON.stringify({ client_email: 'a@b.test', private_key: KEY })
    const refused = await send('POST', '/connections', { ...google, values: { key_file: broken } })
    expect(refused.status).toBe(400)
    expect(refused.text).toContain('The private key is not a PEM private key')
    expect((await send('POST', '/connections', { ...google, values: { key_file: 'not json' } })).text).toContain(
      'The key file is not JSON',
    )
    const made = await data<Connection>('POST', '/connections', google)
    expect(made.missing).toEqual(['key_file'])
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const file = JSON.stringify({
      client_email: 'reader@project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    })
    const filled = await data<Connection>('PUT', `/connections/${made.id}/values/key_file`, { value: file })
    expect(filled.missing).toEqual([])
    const signed = await data<Connection>('PUT', `/connections/${made.id}`, {
      ...google,
      mint: { ...google.mint, issuer: 'app-id' },
    })
    expect(signed.missing).toEqual(['private_key'])
    expectNoValues()
  })

  it('refuses the EA every connection route', async () => {
    for (const [method, url] of [
      ['GET', '/connections'],
      ['POST', '/connections'],
      ['PUT', '/connections/x/values/value'],
      ['DELETE', '/connections/x'],
    ] as const) {
      expect((await send(method, url, method === 'GET' ? undefined : {}, EA_AUTH)).status).toBe(403)
    }
  })
})
