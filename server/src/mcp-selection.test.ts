import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import {
  SANDBOX_POLICY_DEFAULT,
  type CapabilitiesSnapshot,
  type McpSelectionEntry,
  type McpServer,
  type Task,
  type TaskMcpServer,
} from '@seti/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type * as Capabilities from './capabilities.js'
import { tasks } from './db.js'
import { connectorIds, deniedServers, knownServers, selectionKind, taskDeniedServers } from './mcp-selection.js'
import { hostClaudeJson } from './sandbox-mcp.js'
import { sessionOptions, setupKey } from './session-options.js'
import { auditEvents } from './store/audit.js'
import { mcpDefaults, taskMcpChoices } from './store/mcp.js'
import { sandboxPolicy } from './store/sandbox.js'
import { USER_AUTH } from './test-auth.js'
import { renderTask } from './workspace/task-file.js'

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const fake = new FakeSdk(function* () {
    yield fakeResult()
  })
  return { fake, options: [] as Sdk.Options[] }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (params: Parameters<typeof sdk.fake.query>[0]) => {
    sdk.options.push(params.options ?? {})
    return sdk.fake.query(params)
  },
}))

const probe = vi.hoisted(() => ({ snapshots: [] as CapabilitiesSnapshot[] }))

vi.mock('./capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Capabilities>()
  return {
    ...actual,
    capabilityCache: {
      ...actual.capabilityCache,
      all: () => probe.snapshots,
      get: async () => Promise.reject(new Error('tests never probe')),
    },
  }
})

const server = (name: string, patch: Partial<McpServer> = {}): McpServer => ({
  name,
  status: 'connected',
  scope: 'user',
  source: 'user',
  transport: { type: 'http', target: `https://${name}.test/mcp` },
  connector_id: null,
  server_version: null,
  error: null,
  tools: [],
  sign_in: 'none',
  ...patch,
})

const SERVERS = [
  server('clickup'),
  server('sentry'),
  server('plugin:slack:slack', { scope: 'dynamic', source: 'plugin' }),
  server('claude.ai Gmail', {
    scope: 'claudeai',
    source: 'claudeai',
    transport: { type: 'claudeai-proxy', target: 'https://gmail.test/mcp' },
    connector_id: 'mcpsrv_gmail',
  }),
]

const snapshot = (servers: McpServer[]): CapabilitiesSnapshot => ({
  cwd: os.homedir(),
  probed_at: new Date().toISOString(),
  duration_ms: 1,
  pending_timed_out: false,
  account: { email: null, organization: null, subscription_type: null, api_provider: null },
  servers,
  skill_groups: [],
  builtin_commands: [],
  subagents: [],
  models: [],
})

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-mcp-selection-'))
const app = createApp()

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, data: (text === '' ? null : (JSON.parse(text) as { data: T }).data) as T }
}

let count = 0
async function newTask(sandbox: boolean): Promise<Task> {
  const id = `mcp-task-${String(++count)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: scratch, worktree: false, sandbox, pr_urls: [] })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('Task was not stored')
  }
  return task
}

const deniedOf = (options: Sdk.Options) =>
  typeof options.settings === 'object' ? (options.settings.deniedMcpServers ?? []).map((d) => d.serverName) : null

beforeEach(async () => {
  probe.snapshots = [snapshot(SERVERS)]
  for (const name of Object.keys(await mcpDefaults.all())) {
    await mcpDefaults.set(name, true)
  }
})

afterEach(async () => {
  await sandboxPolicy.save(SANDBOX_POLICY_DEFAULT)
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the effective MCP servers of an agent', () => {
  it('leaves out servers off by default unless the agent turns them on, and those it turns off', () => {
    expect(deniedServers({}, {})).toEqual([])
    expect(deniedServers({ sentry: false, clickup: true }, {})).toEqual(['sentry'])
    expect(deniedServers({ sentry: false }, { sentry: true })).toEqual([])
    expect(deniedServers({ sentry: false }, { clickup: false, 'claude.ai Gmail': false })).toEqual([
      'claude.ai Gmail',
      'clickup',
      'sentry',
    ])
  })

  it('tells config, plugin and connector servers apart and finds connector ids by name', () => {
    expect(SERVERS.map(selectionKind)).toEqual(['config', 'config', 'plugin', 'connector'])
    expect(connectorIds(['claude.ai Gmail', 'sentry'], knownServers(probe.snapshots))).toEqual(['mcpsrv_gmail'])
  })
})

describe('MCP defaults', () => {
  it('lists every probed server on by default and audits a changed default', async () => {
    const before = await send<McpSelectionEntry[]>('GET', '/mcp/selection')
    expect(before.data.map((entry) => [entry.name, entry.kind, entry.default_enabled])).toEqual([
      ['claude.ai Gmail', 'connector', true],
      ['clickup', 'config', true],
      ['plugin:slack:slack', 'plugin', true],
      ['sentry', 'config', true],
    ])
    const after = await send<McpSelectionEntry[]>('PUT', `/mcp/defaults/${encodeURIComponent('claude.ai Gmail')}`, {
      enabled: false,
    })
    expect(after.data.find((entry) => entry.name === 'claude.ai Gmail')?.default_enabled).toBe(false)
    expect(await auditEvents.latest('mcp.default_changed')).toMatchObject({
      subject_type: 'mcp_server',
      subject_id: 'claude.ai Gmail',
      detail: { server: 'claude.ai Gmail', enabled: false },
    })
  })

  it('keeps a default for a server the probe no longer lists while the config is unreadable', async () => {
    await mcpDefaults.set('retired', false)
    probe.snapshots = [snapshot(SERVERS.slice(0, 1))]
    const { data } = await send<McpSelectionEntry[]>('GET', '/mcp/selection')
    expect(data.find((entry) => entry.name === 'retired')).toEqual({
      name: 'retired',
      kind: null,
      default_enabled: false,
      known: false,
      local_to: [],
    })
  })

  it('hides servers gone from the config, even while a probe still lists them', async () => {
    await mcpDefaults.set('retired', false)
    const task = await newTask(false)
    await taskMcpChoices.set(task.id, { retired: true, sentry: false })
    fs.writeFileSync(hostClaudeJson(), JSON.stringify({ mcpServers: { clickup: {} } }))
    try {
      const listed = (entries: { name: string }[]) => entries.map((entry) => entry.name)
      const all = ['claude.ai Gmail', 'clickup', 'plugin:slack:slack']
      expect(listed((await send<McpSelectionEntry[]>('GET', '/mcp/selection')).data)).toEqual(all)
      expect(listed((await send<TaskMcpServer[]>('GET', `/tasks/${task.id}/mcp`)).data)).toEqual(all)
    } finally {
      fs.rmSync(hostClaudeJson())
    }
  })

  it('refuses a name with control characters', async () => {
    expect((await send('PUT', '/mcp/defaults/bad%0Aname', { enabled: false })).status).toBe(400)
  })
})

describe('MCP servers of a task', () => {
  it('stores the choices of a new agent and hands the SDK every server it leaves out', async () => {
    await mcpDefaults.set('sentry', false)
    const created = await send<Task>('POST', '/tasks', {
      title: 'Picky',
      prompt: 'Go',
      cwd: scratch,
      sandbox: false,
      mcp_enabled: ['sentry'],
      mcp_disabled: ['plugin:slack:slack', 'claude.ai Gmail'],
    })
    expect(created.status).toBe(200)
    await vi.waitFor(() => {
      expect(deniedOf(sdk.options.at(-1) ?? {})).toEqual(['claude.ai Gmail', 'plugin:slack:slack'])
    })
    expect(await auditEvents.latest('task.created')).toMatchObject({
      detail: { mcp_enabled: ['sentry'], mcp_disabled: ['claude.ai Gmail', 'plugin:slack:slack'] },
    })
    const listed = await send<TaskMcpServer[]>('GET', `/tasks/${created.data.id}/mcp`)
    expect(listed.data.map((s) => [s.name, s.enabled, s.choice])).toEqual([
      ['claude.ai Gmail', false, false],
      ['clickup', true, null],
      ['plugin:slack:slack', false, false],
      ['sentry', true, true],
    ])
  })

  it('applies the same deny list to sandboxed and unsandboxed sessions', async () => {
    await mcpDefaults.set('clickup', false)
    for (const sandbox of [false, true]) {
      const task = await newTask(sandbox)
      await taskMcpChoices.set(task.id, { sentry: false })
      const options = await sessionOptions(task, new AbortController())
      expect(options.spawnClaudeCodeProcess === undefined).toBe(!sandbox)
      expect(deniedOf(options)).toEqual(['clickup', 'sentry'])
    }
  })

  it('restarts the session at the next turn when a choice or a default changes', async () => {
    const task = await newTask(false)
    const first = await setupKey(task)
    const saved = await send<TaskMcpServer[]>('PUT', `/tasks/${task.id}/mcp`, {
      mcp_enabled: [],
      mcp_disabled: ['clickup'],
    })
    expect(saved.data.find((s) => s.name === 'clickup')).toMatchObject({ enabled: false, choice: false })
    const second = await setupKey(task)
    expect(second).not.toBe(first)
    expect(await auditEvents.latest('task.mcp_changed')).toMatchObject({
      subject_id: task.id,
      detail: { mcp_enabled: [], mcp_disabled: ['clickup'] },
    })
    await mcpDefaults.set('sentry', false)
    expect(await setupKey(task)).not.toBe(second)
    expect(await taskDeniedServers(task.id)).toEqual(['clickup', 'sentry'])
  })

  it('lists the servers the agent loads and leaves out in its task file', () => {
    const task = { id: 't', title: 'T', cwd: '/w', repos: [], worktree: false, sandbox: true, pr_urls: [] }
    const text = renderTask({
      task: task as unknown as Task,
      handle: 't',
      packs: [],
      role: null,
      channels: [],
      mcp: { enabled: ['clickup', 'sentry'], disabled: ['claude.ai Gmail'] },
      access: { ssh: ['k8s'], jumps: ['jump'], aws: { state: 'no_role', profile: 'Default' } },
    })
    expect(text).toContain('## MCP servers')
    expect(text).toContain('- On: clickup, sentry')
    expect(text).toContain('- Off: claude.ai Gmail')
    expect(text).toContain('- SSH hosts: k8s')
    expect(text).toContain('- Jump hosts on the way: jump')
    expect(text).toContain('- AWS: off; your credential Default has no AWS role.')
  })
})
