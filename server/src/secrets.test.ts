import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AuditEvent, SecretStatus } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { webhooks } from './channels/service.js'
import { sql } from './db.js'
import { agentToken, agentTokenStamp, githubTokenMode, importAgentTokenFile } from './github-token.js'
import { githubTokens, secret, secrets, SecretUnreadableError } from './secrets.js'
import { auditEvents } from './store/audit.js'
import { channelStore } from './store/channels.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const GITHUB = `github_pat_${'A1b2C3'.repeat(12)}`
const CLAUDE = `sk-ant-oat01-${'Zy9x'.repeat(16)}`
const app = createApp()
const LOCAL = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-secrets-'))

async function send(method: string, url: string, body?: unknown, headers: Record<string, string> = LOCAL) {
  return app.request(`/api${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeEach(async () => {
  await sql`DELETE FROM secret`
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('secret store', () => {
  it('keeps values sealed in the database and opens them for the server', async () => {
    await secrets.set('claude_oauth_token', CLAUDE, 'settings')
    const [row] = await sql<{ sealed: string }[]>`SELECT sealed FROM secret WHERE name = 'claude_oauth_token'`
    expect(row?.sealed).toMatch(/^seti1:/)
    expect(row?.sealed).not.toContain(CLAUDE)
    expect(await secret('claude_oauth_token')).toBe(CLAUDE)
    expect(await secret('github_agent_token')).toBeNull()
  })

  it('refuses a row copied under another name', async () => {
    await githubTokens('default').setDefault(GITHUB)
    await sql`INSERT INTO secret (name, sealed, source, created_at, updated_at)
      SELECT 'claude_oauth_token', sealed, source, created_at, updated_at FROM secret
      WHERE name = 'github_agent_token'`
    await expect(secret('claude_oauth_token')).rejects.toThrow(SecretUnreadableError)
  })

  it('lists every known name with whether it is set, never the value', async () => {
    await secrets.set('claude_oauth_token', CLAUDE, 'settings')
    const list = await secrets.list()
    expect(list).toEqual([
      { name: 'claude_oauth_token', configured: true, source: 'settings', updated_at: expect.any(String) as string },
    ])
    expect(JSON.stringify(list)).not.toContain(CLAUDE)
  })
})

describe('secret routes', () => {
  it('sets, lists and clears secrets without sending a value back', async () => {
    const texts: string[] = []
    const set = await send('PUT', '/secrets/claude_oauth_token', { value: CLAUDE })
    expect(set.status).toBe(200)
    texts.push(await set.text())
    const list = await send('GET', '/secrets')
    const listText = await list.text()
    texts.push(listText)
    const statuses = (JSON.parse(listText) as { data: SecretStatus[] }).data
    expect(statuses[0]).toMatchObject({
      name: 'claude_oauth_token',
      configured: true,
      source: 'settings',
    })
    for (const url of ['/system', '/sandbox', '/audit']) {
      texts.push(await (await send('GET', url)).text())
    }
    const cleared = await send('DELETE', '/secrets/claude_oauth_token')
    texts.push(await cleared.text())
    expect((JSON.parse(texts.at(-1) ?? '{}') as { data: SecretStatus }).data.configured).toBe(false)
    for (const text of texts) {
      expect(text).not.toContain(CLAUDE)
    }
  })

  it('audits each set and clear without the value', async () => {
    await send('PUT', '/secrets/claude_oauth_token', { value: CLAUDE })
    const setEvent = await auditEvents.latest('system.secret_set')
    expect(setEvent).toMatchObject({ actor: 'user', subject_id: 'claude_oauth_token' })
    await send('DELETE', '/secrets/claude_oauth_token')
    const cleared = await auditEvents.latest('system.secret_cleared')
    expect(cleared).toMatchObject({ actor: 'user', subject_id: 'claude_oauth_token' })
    for (const event of [setEvent, cleared] as (AuditEvent | undefined)[]) {
      expect(JSON.stringify(event)).not.toContain(CLAUDE)
    }
  })

  it('does not audit clearing a secret that was not set', async () => {
    const before = await auditEvents.latest('system.secret_cleared')
    expect((await send('DELETE', '/secrets/claude_oauth_token')).status).toBe(200)
    expect(await auditEvents.latest('system.secret_cleared')).toEqual(before)
  })

  it('refuses unknown names, malformed values and the EA', async () => {
    expect((await send('PUT', '/secrets/aws_key', { value: CLAUDE })).status).toBe(404)
    expect((await send('PUT', '/secrets/github_agent_token', { value: GITHUB })).status).toBe(404)
    expect((await send('PUT', '/secrets/claude_oauth_token', { value: 'has spaces in it' })).status).toBe(400)
    expect((await send('PUT', '/secrets/claude_oauth_token', { value: 'short' })).status).toBe(400)
    const ea = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...EA_AUTH }
    expect((await send('GET', '/secrets', undefined, ea)).status).toBe(403)
    expect((await send('PUT', '/secrets/claude_oauth_token', { value: CLAUDE }, ea)).status).toBe(403)
    expect((await send('GET', '/secrets', undefined, { host: '127.0.0.1:3006' })).status).toBe(401)
  })
})

describe('GitHub tokens of a profile', () => {
  const OWNER_TOKEN = `github_pat_${'Q7w8E9'.repeat(12)}`

  it("uses the owner's token for its requests and the profile's default for everything else", async () => {
    await githubTokens('default').setDefault(GITHUB)
    await githubTokens('default').setOwner('Octocat', OWNER_TOKEN)
    expect(await secret('github_agent_token:octocat')).toBe(OWNER_TOKEN)
    expect(await agentToken('default', 'octocat')).toBe(OWNER_TOKEN)
    expect(await agentToken('default', 'OCTOCAT')).toBe(OWNER_TOKEN)
    expect(await agentToken('default', 'globex')).toBe(GITHUB)
    expect(await agentToken('default', null)).toBe(GITHUB)
    await sql`DELETE FROM secret WHERE name = 'github_agent_token'`
    expect(await agentToken('default', 'globex')).toBeNull()
    expect(await githubTokenMode()).toBe('agent')
  })

  it('never falls back to another profile', async () => {
    await githubTokens('default').setDefault(GITHUB)
    await githubTokens('other').setOwner('octocat', OWNER_TOKEN)
    expect(await agentToken('other', 'octocat')).toBe(OWNER_TOKEN)
    expect(await agentToken('other', 'globex')).toBeNull()
    expect(await agentToken('default', 'octocat')).toBe(GITHUB)
    expect((await githubTokens('other').status()).owners.map((owner) => owner.owner)).toEqual(['octocat'])
    await githubTokens('other').clearAll()
    expect(await agentToken('other', 'octocat')).toBeNull()
  })
})

describe('agent token', () => {
  it('comes from the store, restarting sessions through its stamp', async () => {
    expect(await agentTokenStamp()).toBeNull()
    await githubTokens('default').setDefault(GITHUB)
    expect(await agentToken('default')).toBe(GITHUB)
    expect(await agentTokenStamp()).not.toBeNull()
    expect(await githubTokenMode()).toBe('agent')
  })

  it('is imported once from agent.env into the Default profile, audited without its value', async () => {
    const file = path.join(scratch, 'agent.env')
    fs.writeFileSync(file, `# scoped token\nexport GH_TOKEN="${GITHUB}"\n`)
    await importAgentTokenFile(file)
    expect(await secret('github_agent_token')).toBe(GITHUB)
    expect((await githubTokens('default').status()).default).toMatchObject({ configured: true, source: 'import' })
    const event = await auditEvents.latest('system.secret_imported')
    expect(event).toMatchObject({ actor: 'system', subject_id: 'github_agent_token', detail: { from: file } })
    expect(JSON.stringify(event)).not.toContain(GITHUB)

    await githubTokens('default').setDefault(`${GITHUB}new`)
    await importAgentTokenFile(file)
    expect(await secret('github_agent_token')).toBe(`${GITHUB}new`)
  })

  it('imports nothing from a missing or empty file', async () => {
    await importAgentTokenFile(path.join(scratch, 'missing.env'))
    const empty = path.join(scratch, 'empty.env')
    fs.writeFileSync(empty, 'GH_TOKEN=\n')
    await importAgentTokenFile(empty)
    expect(await secret('github_agent_token')).toBeNull()
  })
})

describe('webhook secrets at rest', () => {
  it('are sealed in the database and still verify deliveries', async () => {
    const created = await webhooks.create({ name: 'Sealed', preset: 'generic', subscribe_ea: false, mapping: {} })
    const shown = created.secret ?? ''
    const [row] = await sql<{ secret: string }[]>`SELECT secret FROM channel WHERE id = ${created.channel.id}`
    expect(row?.secret).toMatch(/^seti1:/)
    expect(row?.secret).not.toContain(shown)
    expect((await channelStore.get(created.channel.id))?.secret).toBe(shown)
  })

  it('seals rows that earlier versions stored in the clear', async () => {
    const created = await webhooks.create({ name: 'Legacy', preset: 'generic', subscribe_ea: false, mapping: {} })
    const plain = created.secret ?? ''
    await sql`UPDATE channel SET secret = ${plain} WHERE id = ${created.channel.id}`
    expect((await channelStore.get(created.channel.id))?.secret).toBe(plain)
    expect(await channelStore.sealLegacySecrets()).toBeGreaterThanOrEqual(1)
    const [row] = await sql<{ secret: string }[]>`SELECT secret FROM channel WHERE id = ${created.channel.id}`
    expect(row?.secret).toMatch(/^seti1:/)
    expect((await channelStore.get(created.channel.id))?.secret).toBe(plain)
    expect(await channelStore.unsealSecrets()).toBeGreaterThanOrEqual(1)
    const [back] = await sql<{ secret: string }[]>`SELECT secret FROM channel WHERE id = ${created.channel.id}`
    expect(back?.secret).toBe(plain)
  })

  it('refuses deliveries when the stored secret will not open', async () => {
    const created = await webhooks.create({ name: 'Broken', preset: 'generic', subscribe_ea: false, mapping: {} })
    await sql`UPDATE channel SET secret = ${'seti1:00000000:AAAA:AAAA:AAAA'} WHERE id = ${created.channel.id}`
    const record = await channelStore.get(created.channel.id)
    expect(record?.secret).toBeNull()
    await expect(webhooks.sendTest(created.channel.id)).rejects.toThrow(/does not open with the current key/)
  })
})
