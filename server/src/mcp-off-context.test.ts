import os from 'node:os'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { CapabilitiesSnapshot, ChangeRequest, McpServer, SetiControlLevel, Task } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import type * as Capabilities from './capabilities.js'
import { answerChangeRequest } from './change-requests.js'
import { messages, tasks } from './db.js'
import { mcpOffContext, mcpToolPrefix, offServersText, toolHint } from './mcp-off-context.js'
import { systemAppend } from './session-options.js'
import { REQUEST_TOOLS } from './seti-tools/requests.js'
import { callSetiTool } from './seti-tools/server.js'
import { mcpDefaults, taskMcpChoices } from './store/mcp.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const fake = new FakeSdk(function* () {
    yield fakeResult()
  })
  return { fake }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: sdk.fake.query,
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

const tool = (name: string) => ({ name, description: '', read_only: false, destructive: false, open_world: false })

const server = (name: string, tools: string[] = []): McpServer => ({
  name,
  status: 'connected',
  scope: 'user',
  source: 'user',
  transport: { type: 'http', target: `https://${name}.test/mcp?token=hidden-token` },
  connector_id: null,
  server_version: null,
  error: null,
  tools: tools.map(tool),
  sign_in: 'none',
})

const CHAT_TOOLS = ['chat_send_message', 'chat_schedule_message', 'chat_read_channel', 'chat_search_channels']
const SERVERS = [
  server('plugin:chat:chat', CHAT_TOOLS),
  server('tracker', ['list_issues', 'save_issue']),
  server('bare'),
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

const app = createApp()
const [requestChange] = REQUEST_TOOLS

let count = 0
async function newTask(level: SetiControlLevel = 'self'): Promise<Task> {
  const id = `mcp-off-${String(++count)}`
  const fields = { title: id, repo_id: null, cwd: os.tmpdir(), worktree: false, pr_urls: [], sandbox: false }
  await tasks.insert({ id, ...fields, seti_control: level })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('Task was not stored')
  }
  return task
}

async function ask(caller: Task, name: string) {
  if (requestChange === undefined) {
    throw new Error('no request_change tool')
  }
  const args = { change: { kind: 'mcp_server', server: name }, reason: 'The task needs to post a message there.' }
  const result = await callSetiTool(requestChange, caller.id, args)
  const text = result.content.map((block) => block.text).join('')
  return { text, json: () => JSON.parse(text) as { request: ChangeRequest } }
}

const answer = async (task: Task, id: string, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api/tasks/${task.id}/change-requests/${id}`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'allow' }),
  })

const deniedOf = (options: Sdk.Options | undefined) =>
  typeof options?.settings === 'object' ? (options.settings.deniedMcpServers ?? []).map((d) => d.serverName) : null

beforeEach(async () => {
  probe.snapshots = [snapshot(SERVERS)]
  for (const name of Object.keys(await mcpDefaults.all())) {
    await mcpDefaults.set(name, true)
  }
})

describe('the words a server gets from its tool names', () => {
  it('names the subjects its tools mention most, without the verb and the shared prefix', () => {
    expect(toolHint(CHAT_TOOLS)).toBe('message, channel')
    expect(toolHint(['list_issues', 'save_issue', 'get_issue', 'list_projects', 'save_comment'])).toBe(
      'issue, project, comment',
    )
    expect(toolHint(['search'])).toBe('search')
    expect(toolHint([])).toBeNull()
  })

  it('gives the prefix Claude Code puts before the tools of a server', () => {
    expect(mcpToolPrefix('plugin:chat:chat')).toBe('mcp__plugin_chat_chat__')
    expect(mcpToolPrefix('claude.ai Mail')).toBe('mcp__claude_ai_Mail__')
  })
})

describe('the block of MCP servers that are off', () => {
  it('is absent when nothing is off and names each server with its words when some are', () => {
    expect(offServersText([], 'self')).toBeNull()
    const text = offServersText(
      [
        { name: 'plugin:chat:chat', tools: CHAT_TOOLS },
        { name: 'bare', tools: [] },
      ],
      'self',
    )
    expect(text).toBe(
      'MCP servers on this install that are off for you: plugin:chat:chat (message, channel), bare. ' +
        'Ask for one by this exact name with request_change, kind mcp_server.',
    )
    expect(offServersText([{ name: 'bare', tools: [] }], 'off')).toContain('The user can turn one on in your access.')
  })

  it('names at most eight servers, counts the rest and stays short', () => {
    const many = Array.from({ length: 30 }, (_, n) => ({ name: `server-${String(n)}`, tools: CHAT_TOOLS }))
    const text = offServersText(many, 'full') ?? ''
    expect(text).toContain('server-7 (message, channel), and 22 more that list_mcp_servers names.')
    expect(text).not.toContain('server-8')
    expect(text.length).toBeLessThan(450)
  })

  it('never spells out a name that could hold a URL or a token', () => {
    const text = offServersText(
      [
        { name: 'https://mcp.example.com/sse?key=sk-secret', tools: ['fetch'] },
        { name: 'ok', tools: [] },
      ],
      'self',
    )
    expect(text).toContain('off for you: ok, and 1 more')
    expect(text).not.toContain('sk-secret')
    expect(text).not.toContain('example.com')
  })

  it('reaches the system prompt only while a server is off for the agent, without its URL', async () => {
    const task = await newTask()
    expect(await mcpOffContext(task.id)).toBeNull()
    expect(await systemAppend(task.id)).not.toContain('off for you')

    await mcpDefaults.set('plugin:chat:chat', false)
    await taskMcpChoices.set(task.id, { tracker: false })
    const prompt = await systemAppend(task.id)
    expect(prompt).toContain('off for you: plugin:chat:chat (message, channel), tracker (issue). Ask for one')
    expect(prompt).toContain('call request_change for it at once and carry on with what you can do meanwhile')
    expect(prompt).toContain('Do not search memory, transcripts or the filesystem')
    expect(prompt).not.toContain('hidden-token')
    expect(prompt).not.toContain('.test/mcp')

    await taskMcpChoices.set(task.id, { 'plugin:chat:chat': true })
    expect(await mcpOffContext(task.id)).toBeNull()
  })
})

describe('asking for a server that is off', () => {
  it('takes the name in any case, and Allow starts the turn at once in a session that has it', async () => {
    await mcpDefaults.set('tracker', false)
    const caller = await newTask()
    const { request } = (await ask(caller, 'Tracker')).json()
    expect((await tasks.get(caller.id))?.blocked).toBe('Asks for the MCP server tracker')

    const before = sdk.fake.sessions.length
    const started = Date.now()
    expect((await answer(caller, request.id)).status).toBe(200)
    await vi.waitFor(() => {
      expect(sdk.fake.sessions).toHaveLength(before + 1)
      expect(sdk.fake.last?.prompts.join('\n')).toContain('The user turned on the MCP server tracker for you')
    })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(deniedOf(sdk.fake.last?.options)).toEqual([])
    const note = (await messages.page(caller.id, 20)).messages.flatMap((row) =>
      row.kind === 'input' && row.payload.source === 'seti' ? [row.payload.body] : [],
    )
    expect(note[0]).toContain('its tools start with mcp__tracker__ (list_issues, save_issue)')
    expect((await ask(caller, 'tracker')).text).toContain('You already have the MCP server tracker.')
  })

  it('stays the user to allow: the EA and agents are refused and the server stays off', async () => {
    await mcpDefaults.set('bare', false)
    const caller = await newTask()
    const full = await newTask('full')
    const { request } = (await ask(caller, 'bare')).json()
    expect((await answer(caller, request.id, EA_AUTH)).status).toBe(403)
    await expect(
      asAgent(full, async () => answerChangeRequest(caller, request.id, { decision: 'allow' })),
    ).rejects.toThrow('Agents cannot answer change requests')
    expect(await mcpOffContext(caller.id)).toContain('off for you: bare.')
  })
})
