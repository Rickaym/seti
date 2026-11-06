import fs from 'node:fs'
import path from 'node:path'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { CapabilitiesSnapshot, McpServer, TaskAccessView } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type * as Capabilities from './capabilities.js'
import { CLAUDE_HOME } from './config.js'
import { messages, sql, tasks } from './db.js'
import { sessionMcp, sessionState, watchSessionMcp } from './mcp-session-status.js'
import { runTurn } from './runner.js'
import { hostClaudeJson } from './sandbox-mcp.js'
import { setupKey } from './session-options.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeMessage, fakeResult } = await import('./fake-sdk.js')
  const listed = [
    { name: 'tracker', status: 'pending', source: 'user' },
    { name: 'staging', status: 'pending', source: 'dynamic' },
  ]
  return new FakeSdk(function* () {
    yield fakeMessage('system', { subtype: 'init', model: 'claude', permissionMode: 'default', mcp_servers: listed })
    yield fakeResult()
  })
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (params: Parameters<typeof sdk.query>[0]) => sdk.query(params),
}))

vi.mock('./capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Capabilities>()
  const server = (name: string, scope: string): McpServer => ({
    name,
    status: 'connected',
    scope,
    source: scope,
    transport: { type: 'http', target: `https://${name}.example.com/mcp` },
    connector_id: null,
    server_version: null,
    error: null,
    tools: [],
    sign_in: 'none',
  })
  const snapshot: CapabilitiesSnapshot = {
    cwd: '/home/me/dash',
    probed_at: '2026-10-01T00:00:00.000Z',
    duration_ms: 1,
    pending_timed_out: false,
    account: { email: null, organization: null, subscription_type: null, api_provider: null },
    servers: [server('tracker', 'user'), server('staging', 'local'), server('staging-mine', 'local')],
    skill_groups: [],
    builtin_commands: [],
    subagents: [],
    models: [],
  }
  const needsAuth = { ...snapshot, servers: [{ ...server('staging', 'local'), status: 'needs-auth' as const }] }
  return {
    ...actual,
    capabilityCache: {
      ...actual.capabilityCache,
      all: () => [snapshot],
      get: async () => Promise.reject(new Error('tests never probe')),
      refresh: async (cwd: string) =>
        Promise.resolve(
          cwd === snapshot.cwd
            ? needsAuth
            : { ...snapshot, cwd, servers: [server('tracker', 'user'), server('staging-mine', 'local')] },
        ),
    },
  }
})

const signIns = vi.hoisted(() => [] as { server: string; cwd: string }[])

vi.mock('./mcp-auth.js', () => ({
  mcpAuth: {
    start: async (server: string, cwd: string) => {
      signIns.push({ server, cwd })
      return Promise.resolve({ session_id: 's1', authorization_url: 'https://auth.example/a', callback_expected: true })
    },
  },
}))

const app = createApp()

const staging = { type: 'http', url: 'https://staging.example.com/api/mcp' }

fs.writeFileSync(
  hostClaudeJson(),
  JSON.stringify({
    mcpServers: { tracker: { type: 'http', url: 'https://tracker.example.com/mcp' } },
    projects: {
      '/home/me/dash': { mcpServers: { staging } },
      '/home/me': {
        mcpServers: { 'staging-mine': { ...staging, headers: { Authorization: 'Bearer k' } } },
      },
    },
  }),
)

let count = 0
async function newTask(sandbox: boolean): Promise<string> {
  const id = `mcp-session-${String(++count)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [], sandbox })
  return id
}

async function request(method: string, url: string, body?: unknown) {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, text: await res.text() }
}

async function send(method: string, url: string, body?: unknown) {
  const { status, text } = await request(method, url, body)
  expect(status, text).toBe(200)
  return (JSON.parse(text) as { data: unknown }).data
}

const mcpOf = async (taskId: string) => {
  const view = (await send('GET', `/tasks/${taskId}/access`)) as TaskAccessView
  return Object.fromEntries(view.items.filter((i) => i.kind === 'mcp').map((i) => [i.name, i.session]))
}

const lastOptions = () => sdk.last?.options ?? {}

beforeEach(() => {
  sdk.mcpStatus = []
})

const mcpItems = async (taskId: string) => {
  const view = (await send('GET', `/tasks/${taskId}/access`)) as TaskAccessView
  return Object.fromEntries(view.items.filter((i) => i.kind === 'mcp').map((i) => [i.name, i]))
}

const turn = async (taskId: string, text: string) => {
  await runTurn(taskId, text)
  await waitIdle(taskId)
  const servers = Object.entries(lastOptions().mcpServers ?? {})
  return Object.fromEntries(servers.filter(([name]) => name !== 'seti'))
}

describe('MCP servers of other directories', () => {
  it('stay off by default and say why, while user servers stay on', async () => {
    const taskId = await newTask(false)
    const items = await mcpItems(taskId)
    expect(items.tracker).toMatchObject({ enabled: true, default_enabled: true, detail: 'configured' })
    expect(items.staging).toMatchObject({
      enabled: false,
      default_enabled: false,
      override: null,
      detail: 'From /home/me/dash; off unless turned on',
    })
    expect(await turn(taskId, 'first')).toEqual({})
  })

  it('reach an unsandboxed session once turned on for the agent, from the next turn', async () => {
    const taskId = await newTask(false)
    await turn(taskId, 'first')
    await send('PUT', `/tasks/${taskId}/access`, { kind: 'mcp', id: 'staging', enabled: true })
    const sessions = sdk.sessions.length
    expect(await turn(taskId, 'second')).toEqual({ staging })
    expect(sdk.sessions).toHaveLength(sessions + 1)
    expect((await mcpItems(taskId)).staging).toMatchObject({ enabled: true, override: true })
    const other = await newTask(false)
    expect(await turn(other, 'elsewhere')).toEqual({})
  })

  it('go on for every agent once their Default is turned on, and off again', async () => {
    await send('PUT', '/mcp/defaults/staging', { enabled: true })
    const taskId = await newTask(false)
    expect((await mcpItems(taskId)).staging).toMatchObject({
      enabled: true,
      default_enabled: true,
      detail: 'From /home/me/dash; on by default',
    })
    expect(await turn(taskId, 'first')).toEqual({ staging })
    await send('PUT', '/mcp/defaults/staging', { enabled: false })
    expect(await turn(taskId, 'second')).toEqual({})
  })

  it('stay on for an agent in their own directory, which loads them itself', async () => {
    const id = `mcp-session-${String(++count)}`
    await tasks.insert({ id, title: id, repo_id: null, cwd: '/home/me/dash', worktree: false, pr_urls: [] })
    expect((await mcpItems(id)).staging).toMatchObject({ enabled: true, default_enabled: true, detail: 'configured' })
    expect(await turn(id, 'first')).toEqual({})
  })
})

describe("the agent's access shows how its latest session has each server", () => {
  it('reports connected, needs auth with sign-in, failed and not loaded with plain reasons', async () => {
    const taskId = await newTask(false)
    expect(await mcpOf(taskId)).toMatchObject({ tracker: null, staging: null })
    await send('PUT', `/tasks/${taskId}/access`, { kind: 'mcp', id: 'staging', enabled: true })
    await send('PUT', `/tasks/${taskId}/access`, { kind: 'mcp', id: 'staging-mine', enabled: true })
    sdk.mcpStatus = [
      { name: 'tracker', status: 'needs-auth', config: { type: 'http', url: 'https://tracker.example.com/mcp' } },
      { name: 'staging', status: 'failed', error: 'HTTP 502 from https://staging.example.com/api/mcp?key=k' },
    ]
    await runTurn(taskId, 'hello')
    await waitIdle(taskId)
    await vi.waitFor(async () => {
      expect((await sessionMcp(taskId))?.servers.find((s) => s.name === 'tracker')?.status).toBe('needs-auth')
    })
    const states = await mcpOf(taskId)
    expect(states.tracker).toMatchObject({ status: 'needs-auth', reason: 'Not signed in.', sign_in: 'required' })
    expect(states.staging).toMatchObject({
      status: 'failed',
      reason: 'HTTP 502 from https://staging.example.com/api/mcp',
      sign_in: 'none',
    })
    expect(states['staging-mine']).toMatchObject({ status: 'not_loaded', sign_in: 'none' })
  })

  it('falls back to the recorded session start after a restart', async () => {
    const taskId = await newTask(true)
    const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'tracker', status: 'connected' }] }
    await messages.insert(taskId, { kind: 'sdk', payload: init as Sdk.SDKMessage }, [])
    await send('PUT', `/tasks/${taskId}/access`, { kind: 'mcp', id: 'staging', enabled: true })
    await send('PUT', `/tasks/${taskId}/access`, { kind: 'mcp', id: 'staging-mine', enabled: true })
    expect(await sessionMcp(taskId)).toMatchObject({ servers: [{ name: 'tracker', status: 'connected' }] })
    const states = await mcpOf(taskId)
    expect(states.tracker).toMatchObject({ status: 'connected', reason: null })
    expect(states['staging-mine']?.status).toBe('not_loaded')
    expect(states['staging-mine']?.reason).toMatch(/with keys/)
    expect(states.staging?.status).toBe('not_loaded')
    expect(states.staging?.reason).toMatch(/next turn/)
    await sql`DELETE FROM task_message WHERE task_id = ${taskId}`
  })
})

describe('sessionState and watchSessionMcp', () => {
  const report = { at: 'now', servers: [] }
  const context = { config: undefined, sandboxed: false, signedIn: false, tokenStored: false, inSetup: false }

  it('names the plugin and config cases of a missing server', () => {
    expect(sessionState('plugin:acme:hub', report, context).reason).toBe('Its plugin is not loaded for this agent.')
    expect(sessionState('elsewhere', report, context).reason).toMatch(/another repo's \.mcp\.json/)
  })

  it('asks for a sign-in to a connected client ID server until the host holds its token', () => {
    const hub = { at: 'now', servers: [{ name: 'hub', status: 'connected' as const, error: null, transport: 'http' }] }
    const config = { type: 'http', url: 'https://hub.example.com/mcp', oauth: { clientId: 'seti' } }
    expect(sessionState('hub', hub, { ...context, config })).toMatchObject({
      status: 'needs-auth',
      reason: 'Not signed in.',
      sign_in: 'required',
    })
    expect(sessionState('hub', hub, { ...context, config, tokenStored: true })).toMatchObject({
      status: 'connected',
      reason: null,
      sign_in: 'again',
    })
  })

  it('never asks for a sign-in the host finished after the session started', () => {
    const added = { name: 'web-staging-new', status: 'needs-auth' as const, error: null, transport: 'http' }
    const config = { type: 'http', url: 'https://staging.example.com/api/mcp' }
    const before = { at: 'then', servers: [added], tokens: [] }
    expect(sessionState('web-staging-new', before, { ...context, config, tokenStored: true })).toMatchObject({
      status: 'pending',
      reason: 'Signed in after this session started; the next turn connects with it.',
      sign_in: 'none',
    })
    const after = { ...before, tokens: ['web-staging-new'] }
    expect(sessionState('web-staging-new', after, { ...context, config, tokenStored: true })).toMatchObject({
      status: 'needs-auth',
      sign_in: 'required',
    })
  })

  it('polls until no server is pending, keeping each answer', async () => {
    const answers: Sdk.McpServerStatus[][] = [
      [{ name: 'a', status: 'pending' }],
      [{ name: 'a', status: 'connected', config: { type: 'stdio', command: 'a' } }],
    ]
    let reads = 0
    await watchSessionMcp('watched', async () => Promise.resolve(answers[reads++] ?? null), {
      pollMs: 1,
      settleMs: 1000,
    })
    expect(reads).toBe(2)
    expect((await sessionMcp('watched'))?.servers).toEqual([
      { name: 'a', status: 'connected', error: null, transport: 'stdio' },
    ])
  })
})

describe('signing in to a server of another directory', () => {
  it('runs the sign-in where the server is configured', async () => {
    await send('POST', '/mcp/staging/auth/start', {})
    expect(signIns).toEqual([{ server: 'staging', cwd: '/home/me/dash' }])
  })
})

/** A session start of the task that lists these servers, as Claude Code reports them. */
async function sessionStarted(taskId: string, servers: { name: string; status: string }[]) {
  const init = { type: 'system', subtype: 'init', mcp_servers: servers }
  await messages.insert(taskId, { kind: 'sdk', payload: init as Sdk.SDKMessage }, [])
}

const credentials = path.join(CLAUDE_HOME, '.credentials.json')

function writeLogins(logins: Record<string, { serverName: string; accessToken?: string }>) {
  const entries = Object.fromEntries(
    Object.entries(logins).map(([key, login]) => [key, { serverUrl: staging.url, ...login }]),
  )
  fs.mkdirSync(CLAUDE_HOME, { recursive: true })
  fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'x' }, mcpOAuth: entries }))
}

describe("signing in from an agent's access, where its session and the host probe disagree", () => {
  it('starts the sign-in when the session needs auth although the host probe has it connected', async () => {
    const taskId = await newTask(true)
    await send('PUT', `/tasks/${taskId}/access`, { kind: 'mcp', id: 'staging-mine', enabled: true })
    await sessionStarted(taskId, [{ name: 'staging-mine', status: 'needs-auth' }])
    expect((await mcpOf(taskId))['staging-mine']).toMatchObject({ status: 'needs-auth', sign_in: 'required' })

    const host = await request('POST', '/mcp/staging-mine/auth/start', {})
    expect(host.status).toBe(409)
    expect(host.text).toContain('already connected')

    signIns.length = 0
    const started = await send('POST', '/mcp/staging-mine/auth/start', { task_id: taskId })
    expect(started).toMatchObject({ session_id: 's1' })
    expect(signIns).toEqual([{ server: 'staging-mine', cwd: '/home/me' }])
    await sql`DELETE FROM task_message WHERE task_id = ${taskId}`
  })

  it('offers the sign-in for a keyed server the sandbox leaves out, run where its config lives', async () => {
    const taskId = await newTask(true)
    await send('PUT', `/tasks/${taskId}/access`, { kind: 'mcp', id: 'staging-mine', enabled: true })
    await sessionStarted(taskId, [{ name: 'tracker', status: 'connected' }])
    const state = (await mcpOf(taskId))['staging-mine']
    expect(state).toMatchObject({ status: 'not_loaded', sign_in: 'required' })
    expect(state?.reason).toMatch(/with keys/)

    signIns.length = 0
    await send('POST', '/mcp/staging-mine/auth/start', { task_id: taskId })
    expect(signIns).toEqual([{ server: 'staging-mine', cwd: '/home/me' }])
    await sql`DELETE FROM task_message WHERE task_id = ${taskId}`
  })

  it("leaves the host's answer when the agent's session has the server working", async () => {
    const taskId = await newTask(true)
    await send('PUT', `/tasks/${taskId}/access`, { kind: 'mcp', id: 'staging-mine', enabled: true })
    await sessionStarted(taskId, [{ name: 'staging-mine', status: 'connected' }])
    signIns.length = 0
    const refused = await request('POST', '/mcp/staging-mine/auth/start', { task_id: taskId })
    expect(refused.status).toBe(409)
    expect(signIns).toEqual([])
    expect((await request('POST', '/mcp/staging-mine/auth/start', { task_id: 'no-such-task' })).status).toBe(404)
    await sql`DELETE FROM task_message WHERE task_id = ${taskId}`
  })

  it('starts a new session at the next turn once a sign-in stores the token', async () => {
    writeLogins({ 'staging-mine|1': { serverName: 'staging-mine' } })
    try {
      const taskId = await newTask(false)
      await send('PUT', `/tasks/${taskId}/access`, { kind: 'mcp', id: 'staging-mine', enabled: true })
      await turn(taskId, 'first')
      const task = await tasks.get(taskId)
      if (task === undefined) {
        throw new Error('task is missing')
      }
      const before = await setupKey(task)
      const sessions = sdk.sessions.length
      writeLogins({ 'staging-mine|1': { serverName: 'staging-mine', accessToken: 'signed-in' } })
      expect(await setupKey(task)).not.toBe(before)
      await turn(taskId, 'second')
      expect(sdk.sessions).toHaveLength(sessions + 1)
    } finally {
      fs.rmSync(credentials, { force: true })
    }
  })
})
