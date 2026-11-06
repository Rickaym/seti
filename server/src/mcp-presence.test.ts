import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CapabilitiesSnapshot, McpServer } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tasks } from './db.js'
import {
  forgetGoneMcpServers,
  forgetRemovedMcpServer,
  goneServers,
  readMcpConfigs,
  type McpConfigRead,
} from './mcp-presence.js'
import { hostClaudeJson } from './sandbox-mcp.js'
import { auditEvents } from './store/audit.js'
import { mcpDefaults, storedMcpNames, taskMcpChoices } from './store/mcp.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-mcp-presence-'))
vi.spyOn(os, 'homedir').mockReturnValue(scratch)

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

let count = 0
function dir(files: Record<string, string> = {}): string {
  const made = path.join(scratch, `dir-${String(++count)}`)
  fs.mkdirSync(made)
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(made, name), text)
  }
  return made
}

const servers = (...names: string[]) => JSON.stringify({ mcpServers: Object.fromEntries(names.map((n) => [n, {}])) })

function hostFile(text: string): string {
  const file = path.join(dir(), '.claude.json')
  fs.writeFileSync(file, text)
  return file
}

const HOST = JSON.stringify({
  mcpServers: { clickup: {} },
  projects: { '/w/a': { mcpServers: { 'a-local': {} } }, '/w/b': {} },
})

describe('reading the MCP config files', () => {
  it('collects user, local and project servers of repos and agent directories', () => {
    const repo = dir({ '.mcp.json': servers('repo-project') })
    const agent = dir({ '.mcp.json': servers('agent-project') })
    const read = readMcpConfigs({ hostFile: hostFile(HOST), repos: [repo], agents: [agent, dir()] })
    expect([...read.names].toSorted((a, b) => a.localeCompare(b))).toEqual([
      'a-local',
      'agent-project',
      'clickup',
      'repo-project',
    ])
    expect(read.complete).toBe(true)
  })

  it('skips an agent directory that is gone but not a repo checkout that is missing', () => {
    const gone = path.join(scratch, 'never-made')
    expect(readMcpConfigs({ hostFile: hostFile(HOST), repos: [], agents: [gone] }).complete).toBe(true)
    expect(readMcpConfigs({ hostFile: hostFile(HOST), repos: [gone], agents: [] }).complete).toBe(false)
  })

  it('is incomplete when a config file is missing, half written or not an object', () => {
    const missing = path.join(scratch, 'no-such', '.claude.json')
    expect(readMcpConfigs({ hostFile: missing, repos: [], agents: [] }).complete).toBe(false)
    expect(readMcpConfigs({ hostFile: hostFile('{"mcpServers": {'), repos: [], agents: [] }).complete).toBe(false)
    const broken = dir({ '.mcp.json': '{"mcpServers"' })
    const read = readMcpConfigs({ hostFile: hostFile(HOST), repos: [], agents: [broken] })
    expect(read).toMatchObject({ complete: false })
    expect(read.names.has('clickup')).toBe(true)
    expect(readMcpConfigs({ hostFile: hostFile('[]'), repos: [], agents: [] }).complete).toBe(false)
  })
})

const server = (name: string, patch: Partial<McpServer> = {}): McpServer => ({
  name,
  status: 'connected',
  scope: 'user',
  source: 'user',
  transport: { type: 'http', target: null },
  connector_id: null,
  server_version: null,
  error: null,
  tools: [],
  sign_in: 'none',
  ...patch,
})

const plugin = (name: string) => server(name, { scope: 'dynamic', source: 'plugin' })
const connector = (name: string) =>
  server(name, { scope: 'claudeai', source: 'claudeai', transport: { type: 'claudeai-proxy', target: null } })

const snapshot = (minutesAgo: number, list: McpServer[]): CapabilitiesSnapshot => ({
  cwd: '/w/a',
  probed_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  duration_ms: 1,
  pending_timed_out: false,
  account: { email: null, organization: null, subscription_type: null, api_provider: null },
  servers: list,
  skill_groups: [],
  builtin_commands: [],
  subagents: [],
  models: [],
})

const read = (complete: boolean, ...names: string[]): McpConfigRead => ({ names: new Set(names), complete })

describe('which servers are gone', () => {
  it('drops a config server a complete read lacks, even while an older probe still lists it', () => {
    const gone = goneServers(read(true, 'clickup'), [snapshot(5, [server('clickup'), server('deleted')])])
    expect(gone('clickup')).toBe(false)
    expect(gone('deleted')).toBe(true)
  })

  it('keeps every config server while any config file could not be read', () => {
    const gone = goneServers(read(false, 'clickup'), [])
    expect(gone('deleted')).toBe(false)
  })

  it('keeps a plugin server until a probe loads its plugin without it', () => {
    const name = 'plugin:slack:slack'
    expect(goneServers(read(true), [])(name)).toBe(false)
    expect(goneServers(read(true), [snapshot(5, [plugin('plugin:other:x')])])(name)).toBe(false)
    const dropped = [snapshot(60, [plugin(name)]), snapshot(1, [plugin('plugin:slack:files')])]
    expect(goneServers(read(true), dropped)(name)).toBe(true)
    expect(goneServers(read(false), [snapshot(1, [plugin(name)])])(name)).toBe(false)
  })

  it('keeps a claude.ai connector until a probe lists connectors without it', () => {
    const name = 'claude.ai Gmail'
    expect(goneServers(read(true), [snapshot(1, [server('clickup')])])(name)).toBe(false)
    expect(goneServers(read(true), [snapshot(1, [connector(name)])])(name)).toBe(false)
    const dropped = [snapshot(60, [connector(name)]), snapshot(1, [connector('claude.ai Drive')])]
    expect(goneServers(read(true), dropped)(name)).toBe(true)
  })

  it('keeps servers from sources Seti does not read while a probe lists them', () => {
    const managed = server('managed', { scope: 'enterprise', source: 'enterprise' })
    expect(goneServers(read(true), [snapshot(1, [managed])])('managed')).toBe(false)
  })
})

describe('forgetting stored choices', () => {
  let task = ''

  beforeEach(async () => {
    task = `presence-task-${String(++count)}`
    await tasks.insert({
      id: task,
      title: task,
      repo_id: null,
      cwd: scratch,
      worktree: false,
      sandbox: false,
      pr_urls: [],
    })
    for (const name of await storedMcpNames()) {
      await mcpDefaults.set(name, true)
    }
    await mcpDefaults.set('deleted', false)
    await mcpDefaults.set('clickup', false)
    await taskMcpChoices.set(task, { deleted: false, clickup: true, 'plugin:slack:slack': false })
  })

  it('forgets servers gone from every config file and audits their names only', async () => {
    fs.writeFileSync(hostClaudeJson(), HOST)
    expect(await forgetGoneMcpServers()).toEqual(['deleted'])
    expect(await mcpDefaults.all()).toEqual({ clickup: false })
    expect(await taskMcpChoices.get(task)).toEqual({ clickup: true, 'plugin:slack:slack': false })
    expect(await auditEvents.latest('mcp.choices_forgotten')).toMatchObject({
      actor: 'system',
      subject_type: 'mcp_server',
      subject_id: 'deleted',
      detail: { servers: ['deleted'] },
    })
  })

  it('forgets nothing while the user config is unreadable', async () => {
    fs.writeFileSync(hostClaudeJson(), '{"mcpServers": {"clickup"')
    expect(await forgetGoneMcpServers()).toEqual([])
    expect(await mcpDefaults.all()).toEqual({ clickup: false, deleted: false })
  })

  it('forgets a server Seti removed unless another config still has it', async () => {
    fs.writeFileSync(hostClaudeJson(), '{"mcpServers": {"clickup"')
    expect(await forgetRemovedMcpServer('deleted')).toEqual(['deleted'])
    expect(await taskMcpChoices.get(task)).toEqual({ clickup: true, 'plugin:slack:slack': false })
    fs.writeFileSync(hostClaudeJson(), HOST)
    expect(await forgetRemovedMcpServer('clickup')).toEqual([])
    expect(await mcpDefaults.all()).toEqual({ clickup: false })
  })
})
