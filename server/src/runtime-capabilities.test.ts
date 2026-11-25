import type { CapabilitiesSnapshot, McpServer, McpTransport, Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { startDream } from './dreams/start.js'
import {
  pluginRuntimes,
  runtimeCapabilities,
  serverProblem,
  serverRuntimes,
  withRuntimes,
} from './runtimes/capabilities.js'
import { setTaskSandbox } from './tasks.js'
import { USER_AUTH } from './test-auth.js'
import { renderTask } from './workspace/task-file.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-capabilities-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
})

const CODEX = 'capabilities-codex-agent'
await tasks.insert({ id: CODEX, title: 'Codex caps', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
await sql`UPDATE task SET runtime = 'codex', sandbox = 1 WHERE id = ${CODEX}`

async function codexTask(): Promise<Task> {
  const task = await tasks.get(CODEX)
  if (task === undefined) {
    throw new Error('the task was not stored')
  }
  return task
}

const app = createApp({ access: null, verify: null })
const HEADERS = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }

describe("what an agent's runtime declares", () => {
  it('serves each runtime what its adapter declares: Claude Code all, Codex some of these', async () => {
    const served = (await (await app.request('/api/runtimes/capabilities', { headers: HEADERS })).json()) as {
      data: unknown
    }
    expect(served.data).toEqual(runtimeCapabilities())
    expect(runtimeCapabilities().claude).toMatchObject({ mcp_servers: true, plugins: true, dreams: true })
    expect(runtimeCapabilities().claude.mcp_transports).toEqual(['stdio', 'sse', 'http', 'sdk', 'claudeai-proxy'])
    expect(runtimeCapabilities().codex).toEqual({
      label: 'Codex',
      mcp_servers: true,
      mcp_transports: ['stdio', 'http'],
      plugins: false,
      unsandboxed: false,
      compaction: false,
      side_chat: false,
      dreams: false,
      rewind: false,
    })
  })

  it("says in the task file of a runtime that loads none of the user's MCP servers that it loads none", async () => {
    const text = renderTask({
      task: await codexTask(),
      handle: 'codex',
      packs: [],
      role: null,
      channels: [],
      mcp: null,
      access: { ssh: [], jumps: [], aws: { state: 'no_role', profile: 'Default' } },
    })
    expect(text).toContain("Your sessions load none of the user's MCP servers")
    expect(text).not.toContain('- On:')
  })

  it('refuses to run a Codex agent unsandboxed, a compaction rule and a dream', async () => {
    const task = await codexTask()
    await expect(setTaskSandbox(task, false)).rejects.toThrow('Codex agents have no way to run outside the sandbox')
    await setTaskSandbox(task, true)
    const compact = await app.request(`/api/tasks/${CODEX}/compact`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({ rule: null }),
    })
    expect(compact.status).toBe(409)
    await expect(startDream(task)).rejects.toThrow("The agent's runtime keeps no memory Seti can find.")
  })

  it("says which runtimes can use each MCP server: those that take its transport and name, and a plugin's only where plugins load", () => {
    const server = (type: McpTransport['type'], name = 'docs', plugin = false) => ({ name, type, plugin })
    expect(serverRuntimes(server('stdio'))).toEqual(['claude', 'codex'])
    expect(serverRuntimes(server('http'))).toEqual(['claude', 'codex'])
    expect(serverRuntimes(server('sse'))).toEqual(['claude'])
    expect(serverRuntimes(server('claudeai-proxy'))).toEqual(['claude'])
    expect(serverRuntimes(server('stdio', 'has space'))).toEqual(['claude'])
    expect(serverRuntimes(server('http', 'plugin:acme:docs', true))).toEqual(['claude'])
    expect(serverProblem('codex', server('sse'))).toBe('Codex agents cannot use SSE servers.')
    expect(serverProblem('codex', server('stdio', 'has space'))).toBe(
      'Codex takes server names of letters, digits, - and _ only.',
    )
    expect(serverProblem('codex', server('stdio', 'plugin:acme:docs', true))).toBe(
      'Codex agents load no plugins, so none of their servers.',
    )
    expect(pluginRuntimes()).toEqual(['claude'])
  })

  it('leaves a server untagged while its transport is unknown', () => {
    const server = (name: string, transport: McpTransport | null): McpServer => ({
      name,
      status: 'connected',
      scope: 'user',
      source: null,
      transport,
      connector_id: null,
      server_version: null,
      error: null,
      tools: [],
      sign_in: 'none',
    })
    const snapshot: CapabilitiesSnapshot = {
      cwd: '/work',
      probed_at: '2026-11-24T00:00:00.000Z',
      duration_ms: 1,
      pending_timed_out: false,
      account: { email: null, organization: null, subscription_type: null, api_provider: null },
      servers: [server('known', { type: 'stdio', target: 'node' }), server('unknown', null)],
      skill_groups: [],
      builtin_commands: [],
      subagents: [],
      models: [],
    }
    expect(withRuntimes(snapshot).servers.map((s) => s.runtimes)).toEqual([['claude', 'codex'], undefined])
  })
})
