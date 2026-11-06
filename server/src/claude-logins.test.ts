import fs from 'node:fs'
import path from 'node:path'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { AccountStatus, ClaudeLogin } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { claudeCredential } from './claude-credential.js'
import {
  createLoginKeeper,
  hostLoginKey,
  loginPaths,
  removeLogin,
  saveCurrentLogin,
  switchLogin,
} from './claude-logins.js'
import { sql, tasks } from './db.js'
import { setupKey } from './session-options.js'
import { auditEvents } from './store/audit.js'
import { secretRows } from './store/secrets.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: () => {
    const session = (async function* () {
      await Promise.resolve()
      yield* []
    })()
    return Object.assign(session, { close: () => undefined })
  },
}))

const app = createApp()
const BASE = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006' }
const USER = { ...BASE, ...USER_AUTH }
const EA = { ...BASE, ...EA_AUTH }

const fake = (...parts: string[]) => [...parts, 'Tk9x'].join('-')
const WORK = { access: fake('work', 'access'), refresh: fake('work', 'refresh') }
const HOME = { access: fake('home', 'access'), refresh: fake('home', 'refresh') }
const MCP = { 'linear|abc': { serverName: 'linear', accessToken: fake('mcp', 'linear') } }

const oauth = (tokens: { access: string; refresh: string }, plan = 'max') => ({
  accessToken: tokens.access,
  refreshToken: tokens.refresh,
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: plan,
})

const profile = (who: string) => ({
  accountUuid: `uuid-${who}`,
  organizationUuid: `org-${who}`,
  emailAddress: `${who}@example.test`,
  organizationName: `${who} org`,
})

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>

function signIn(tokens: { access: string; refresh: string }, who: string, extra: Record<string, unknown> = {}) {
  const paths = loginPaths()
  fs.mkdirSync(path.dirname(paths.credentials), { recursive: true })
  const current = fs.existsSync(paths.credentials) ? readJson(paths.credentials) : {}
  fs.writeFileSync(paths.credentials, JSON.stringify({ ...current, ...extra, claudeAiOauth: oauth(tokens) }), {
    mode: 0o600,
  })
  const config = fs.existsSync(paths.config) ? readJson(paths.config) : { numStartups: 7 }
  fs.writeFileSync(paths.config, JSON.stringify({ ...config, oauthAccount: profile(who) }, null, 2))
}

/** Every response body and stderr line the tests saw, to check no token ever leaves. */
const seen: string[] = []

async function send(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  seen.push(await res.clone().text())
  return res
}

async function data<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await send(USER, method, url, body)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const tokensOf = (tokens: { access: string; refresh: string }) => [tokens.access, tokens.refresh]
const ALL_TOKENS = [...tokensOf(WORK), ...tokensOf(HOME)]

let stderr: MockInstance<typeof process.stderr.write>

beforeEach(async () => {
  await sql`DELETE FROM claude_login`
  await sql`DELETE FROM secret WHERE starts_with(name, 'claude_login:')`
  fs.rmSync(loginPaths().credentials, { force: true })
  fs.rmSync(loginPaths().config, { force: true })
  stderr = vi.spyOn(process.stderr, 'write')
})

afterEach(async () => {
  const logged = stderr.mock.calls.map((call) => String(call[0])).join('\n')
  const audited = JSON.stringify(await auditEvents.page({ limit: 200 }))
  for (const token of ALL_TOKENS) {
    expect(logged).not.toContain(token)
    expect(audited).not.toContain(token)
    expect(seen.join('\n')).not.toContain(token)
  }
  for (const row of await secretRows.withPrefix('claude_login:')) {
    for (const token of ALL_TOKENS) {
      expect(row.sealed).not.toContain(token)
    }
  }
  stderr.mockRestore()
})

describe('saved Claude logins', () => {
  it('captures the login in use under a name, once, without its tokens leaving the server', async () => {
    signIn(WORK, 'work')
    const work = await data<ClaudeLogin>('POST', '/account/logins', { name: 'Work' })
    expect(work).toMatchObject({ name: 'Work', email: 'work@example.test', plan: 'max' })
    const again = await send(USER, 'POST', '/account/logins', { name: 'Other' })
    expect(again.status).toBe(409)
    expect(await again.text()).toContain('already saved as Work')

    const status = await data<AccountStatus>('GET', '/account')
    expect(status.logins.active_id).toBe(work.id)
    expect(status.logins.unsaved).toBeNull()
    expect(await auditEvents.latest('account.login_saved')).toMatchObject({ detail: { name: 'Work' } })
  })

  it('switches only the Claude login, keeps MCP sign-ins and config, and saves refreshed tokens back', async () => {
    signIn(HOME, 'home')
    const home = await saveCurrentLogin('Personal')
    signIn(WORK, 'work', { mcpOAuth: MCP, somethingElse: 1 })
    const work = await saveCurrentLogin('Work')
    const refreshed = { access: fake('work', 'access', 'r2'), refresh: fake('work', 'refresh', 'r2') }
    ALL_TOKENS.push(...tokensOf(refreshed))
    signIn(refreshed, 'work')

    const result = await data<{ login: ClaudeLogin; kept: ClaudeLogin | null }>(
      'POST',
      `/account/logins/${home.id}/switch`,
      {},
    )
    expect(result).toMatchObject({ login: { name: 'Personal' }, kept: null })
    const file = readJson(loginPaths().credentials)
    expect(file).toMatchObject({ mcpOAuth: MCP, somethingElse: 1, claudeAiOauth: { accessToken: HOME.access } })
    expect(readJson(loginPaths().config)).toMatchObject({ numStartups: 7, oauthAccount: profile('home') })
    expect(fs.statSync(loginPaths().credentials).mode & 0o777).toBe(0o600)
    expect(await auditEvents.latest('account.switched')).toMatchObject({ detail: { name: 'Personal' } })

    await switchLogin(work.id)
    expect(readJson(loginPaths().credentials)).toMatchObject({
      mcpOAuth: MCP,
      claudeAiOauth: { accessToken: refreshed.access, refreshToken: refreshed.refresh },
    })
  })

  it('waits for Claude Code to release its write lock before switching', async () => {
    signIn(HOME, 'home')
    const home = await saveCurrentLogin('Personal')
    signIn(WORK, 'work')
    await saveCurrentLogin('Work')
    const lock = path.join(path.dirname(loginPaths().credentials), '.storage-write.lock')
    fs.mkdirSync(lock)
    const switching = switchLogin(home.id)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(readJson(loginPaths().credentials)).toMatchObject({ claudeAiOauth: { accessToken: WORK.access } })
    fs.rmSync(lock, { recursive: true })
    await switching
    expect(readJson(loginPaths().credentials)).toMatchObject({ claudeAiOauth: { accessToken: HOME.access } })
  })

  it('keeps a login no saved one matches by saving it under its email before switching away', async () => {
    signIn(HOME, 'home')
    const home = await saveCurrentLogin('Personal')
    signIn(WORK, 'work')
    const status = await data<AccountStatus>('GET', '/account')
    expect(status.logins).toMatchObject({ active_id: null, unsaved: { email: 'work@example.test' } })

    const { kept } = await switchLogin(home.id)
    expect(kept?.name).toBe('work@example.test')
    await switchLogin(kept?.id ?? '')
    expect(readJson(loginPaths().credentials)).toMatchObject({ claudeAiOauth: { accessToken: WORK.access } })
  })

  it('follows Claude Code refreshes and a terminal /login into the matching slot once they hold still', async () => {
    signIn(WORK, 'work')
    const work = await saveCurrentLogin('Work')
    signIn(HOME, 'home')
    const home = await saveCurrentLogin('Personal')
    const keeper = createLoginKeeper()
    const relogin = { access: fake('work', 'access', 'r3'), refresh: fake('work', 'refresh', 'r3') }
    ALL_TOKENS.push(...tokensOf(relogin))
    signIn(relogin, 'work')
    expect(await keeper.check()).toBe('none')
    expect(await keeper.check()).toBe('saved')

    signIn(HOME, 'home')
    await switchLogin(work.id)
    expect(readJson(loginPaths().credentials)).toMatchObject({ claudeAiOauth: { accessToken: relogin.access } })
    expect((await data<AccountStatus>('GET', '/account')).logins.active_id).toBe(work.id)
    expect(home.id).not.toBe(work.id)

    fs.rmSync(loginPaths().credentials)
    expect(await keeper.check()).toBe('signed_out')
    expect((await data<AccountStatus>('GET', '/account')).logins.accounts).toHaveLength(2)
  })

  it('trusts the tokens over a stale profile Claude Code wrote back, and repairs the profile', async () => {
    signIn(WORK, 'work')
    const work = await saveCurrentLogin('Work')
    signIn(HOME, 'home')
    const home = await saveCurrentLogin('Personal')
    await switchLogin(work.id)
    const workKey = hostLoginKey()
    await switchLogin(home.id)
    const config = readJson(loginPaths().config)
    fs.writeFileSync(loginPaths().config, JSON.stringify({ ...config, oauthAccount: profile('work') }))
    expect(hostLoginKey()).not.toBe(workKey)
    expect((await data<AccountStatus>('GET', '/account')).logins.active_id).toBe(home.id)

    const keeper = createLoginKeeper()
    await keeper.check()
    expect(await keeper.check()).toBe('saved')
    expect(readJson(loginPaths().config)).toMatchObject({ oauthAccount: profile('home') })
    await switchLogin(work.id)
    expect(readJson(loginPaths().credentials)).toMatchObject({ claudeAiOauth: { accessToken: WORK.access } })
    await switchLogin(home.id)
    expect(readJson(loginPaths().credentials)).toMatchObject({ claudeAiOauth: { accessToken: HOME.access } })
  })

  it('refuses removing the login in use, and removes another after a confirmation in the UI', async () => {
    signIn(HOME, 'home')
    const home = await saveCurrentLogin('Personal')
    signIn(WORK, 'work')
    const work = await saveCurrentLogin('Work')
    const refused = await send(USER, 'DELETE', `/account/logins/${work.id}`)
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('switch to another one first')
    const renamed = await data<ClaudeLogin>('PATCH', `/account/logins/${home.id}`, { name: 'Home' })
    expect(renamed.name).toBe('Home')
    expect((await send(USER, 'PATCH', `/account/logins/${home.id}`, { name: 'work' })).status).toBe(409)
    await removeLogin(home.id)
    expect(await secretRows.get(`claude_login:${home.id}`)).toBeUndefined()
    expect(await auditEvents.latest('account.login_removed')).toMatchObject({ detail: { name: 'Home' } })
  })

  it('lets the EA and agents read the logins but never add, rename, remove or switch them', async () => {
    signIn(HOME, 'home')
    const home = await saveCurrentLogin('Personal')
    signIn(WORK, 'work')
    const work = await saveCurrentLogin('Work')
    const read = await send(EA, 'GET', '/account')
    expect(read.status).toBe(200)
    const view = ((await read.json()) as { data: AccountStatus }).data.logins
    expect(view.accounts.map((login) => login.name)).toEqual(['Personal', 'Work'])
    for (const [method, url, body] of [
      ['POST', '/account/logins', { name: 'EA' }],
      ['PATCH', `/account/logins/${home.id}`, { name: 'EA' }],
      ['DELETE', `/account/logins/${home.id}`, undefined],
      ['POST', `/account/logins/${home.id}/switch`, {}],
      ['POST', '/account/sign-in', { name: 'EA' }],
    ] as const) {
      expect((await send(EA, method, url, body)).status).toBe(403)
    }
    const agent = { id: 'agent-1', title: 'Agent', seti_control: 'full' as const }
    await expect(asAgent(agent, async () => switchLogin(home.id))).rejects.toThrow('Only the user')
    await expect(asAgent(agent, async () => removeLogin(home.id))).rejects.toThrow('Only the user')
    expect(readJson(loginPaths().credentials)).toMatchObject({ claudeAiOauth: { accessToken: WORK.access } })
    expect(work.name).toBe('Work')
  })

  it("restarts a session on its next turn after a switch and keeps a running sandbox on its login's token", async () => {
    signIn(HOME, 'home')
    const home = await saveCurrentLogin('Personal')
    signIn(WORK, 'work')
    await saveCurrentLogin('Work')
    await tasks.insert({ id: 'logins-task', title: 'T', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    const task = await tasks.get('logins-task')
    if (task === undefined) {
      throw new Error('The task was not stored')
    }
    const before = await setupKey(task)
    const startedOn = hostLoginKey()
    expect(await claudeCredential(startedOn)).toEqual({ source: 'login', token: WORK.access })

    await switchLogin(home.id)
    expect(await setupKey(task)).not.toBe(before)
    expect(await claudeCredential(startedOn)).toEqual({ source: 'login', token: WORK.access })
    expect(await claudeCredential(hostLoginKey())).toEqual({ source: 'login', token: HOME.access })
  })
})
