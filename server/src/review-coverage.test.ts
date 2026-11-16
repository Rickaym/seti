import type {
  CapabilitiesSnapshot,
  McpServer,
  McpTool,
  PermissionPolicy,
  PermissionRule,
  ReviewCoverage,
} from '@seti/shared'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { capabilityCache } from './capabilities.js'
import { tasks } from './db.js'
import { addPermissionRules } from './permission-rules.js'
import { reviewCoverage, reviewGaps, serverRule, toolServers, writingTools } from './review-coverage.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

type Hints = Partial<Pick<McpTool, 'read_only' | 'destructive' | 'open_world'>>

const tool = (name: string, hints: Hints = {}): McpTool => ({
  name,
  description: '',
  read_only: false,
  destructive: false,
  open_world: false,
  ...hints,
})

const server = (name: string, tools: McpTool[]): McpServer => ({
  name,
  status: 'connected',
  scope: 'user',
  source: null,
  transport: null,
  connector_id: null,
  server_version: null,
  error: null,
  tools,
  sign_in: 'none',
})

const snapshot = (probedAt: string, servers: McpServer[]): CapabilitiesSnapshot => ({
  cwd: `/tmp/${probedAt}`,
  probed_at: probedAt,
  duration_ms: 1,
  pending_timed_out: false,
  account: { email: null, organization: null, subscription_type: null, api_provider: null },
  servers,
  skill_groups: [],
  builtin_commands: [],
  subagents: [],
  models: [],
})

const OPEN = { open_world: true }
const READ = { read_only: true, open_world: true }

/** A chat server that annotates every tool, as a plugin's server does. */
const CHAT = server('plugin:chat:chat', [
  tool('chat_send_message', OPEN),
  tool('chat_schedule_message', OPEN),
  tool('chat_complete_file_upload', OPEN),
  tool('chat_update_canvas', { ...OPEN, destructive: true }),
  tool('chat_read_channel', READ),
  tool('chat_search_users', READ),
])

/** A server that gives no annotations, so the words of each tool's name decide. */
const PLAIN = server('tracker', [tool('create_issue'), tool('list_issues'), tool('get_issue'), tool('triage')])

const CHAT_RULE = 'mcp__plugin_chat_chat'
const servers = toolServers([snapshot('2026-01-02T00:00:00.000Z', [CHAT, PLAIN])])
const names = (coverage: ReviewCoverage) => coverage.tools.map((t) => t.name)

describe('the tools of a server that write or send', () => {
  it("spells a server's rule as Claude Code names its tools", () => {
    expect(serverRule('plugin:chat:chat')).toBe(CHAT_RULE)
    expect(serverRule('claude.ai Google Drive')).toBe('mcp__claude_ai_Google_Drive')
    expect(serverRule('my-server')).toBe('mcp__my-server')
  })

  it("follow the server's annotations: every tool not read-only, a file upload included", () => {
    const tools = writingTools(CHAT, CHAT_RULE)
    expect(tools.map((t) => t.name)).toEqual([
      'chat_send_message',
      'chat_schedule_message',
      'chat_complete_file_upload',
      'chat_update_canvas',
    ])
    expect(tools.every((t) => t.basis === 'annotations' && t.outward)).toBe(true)
    expect(tools[2]?.rule).toBe(`${CHAT_RULE}__chat_complete_file_upload`)
  })

  it('select only open-world tools when the server marks some so, and all when it marks none', () => {
    const mixed = server('mixed', [tool('post', OPEN), tool('rename'), tool('peek', { read_only: true })])
    expect(writingTools(mixed, 'mcp__mixed').map((t) => [t.name, t.outward])).toEqual([
      ['post', true],
      ['rename', false],
    ])
    const closed = server('closed', [tool('post'), tool('peek', { read_only: true })])
    expect(writingTools(closed, 'mcp__closed')).toEqual([
      { rule: 'mcp__closed__post', name: 'post', basis: 'annotations', outward: true },
    ])
  })

  it('fall back to the words of each name, and list a name with no known word unselected', () => {
    expect(writingTools(PLAIN, 'mcp__tracker')).toEqual([
      { rule: 'mcp__tracker__create_issue', name: 'create_issue', basis: 'name', outward: true },
      { rule: 'mcp__tracker__triage', name: 'triage', basis: 'unknown', outward: false },
    ])
  })

  it('come from the newest probe that lists the tools of a server', () => {
    const old = snapshot('2026-01-01T00:00:00.000Z', [server('tracker', [tool('create_issue')])])
    const failed = snapshot('2026-01-03T00:00:00.000Z', [{ ...server('tracker', []), status: 'failed' }])
    const newest = snapshot('2026-01-02T00:00:00.000Z', [PLAIN])
    expect(toolServers([old, failed, newest]).get('mcp__tracker')?.tools).toHaveLength(4)
  })
})

describe('review coverage', () => {
  it('lists the sibling tools of a rule and marks the ones already reviewed', () => {
    const send = `${CHAT_RULE}__chat_send_message`
    const coverage = reviewCoverage(send, [send], servers)
    expect(coverage).toMatchObject({ server: CHAT_RULE, label: 'Chat', tool: send, known: true })
    expect(names(coverage)).toContain('chat_complete_file_upload')
    expect(coverage.tools.filter((t) => t.reviewed).map((t) => t.rule)).toEqual([send])
  })

  it('reads a rule for the whole server as no tool, with every tool reviewed', () => {
    const coverage = reviewCoverage(CHAT_RULE, [CHAT_RULE], servers)
    expect(coverage.tool).toBeNull()
    expect(coverage.tools.every((t) => t.reviewed)).toBe(true)
  })

  it('says so when no probe lists the server', () => {
    expect(reviewCoverage('mcp__plugin_mail_mail__send', [], servers)).toEqual({
      server: 'mcp__plugin_mail_mail',
      label: 'Mail',
      tool: 'mcp__plugin_mail_mail__send',
      known: false,
      tools: [],
    })
  })

  it('counts the outward tools a partly reviewed server leaves out', () => {
    const two = [`${CHAT_RULE}__chat_send_message`, `${CHAT_RULE}__chat_schedule_message`]
    expect(reviewGaps(two, two, servers)).toEqual([{ server: CHAT_RULE, label: 'Chat', uncovered: 2 }])
  })

  it('reports no gap for a server with no rule, a server rule, or full coverage', () => {
    expect(reviewGaps([], [], servers)).toEqual([])
    const one = [`${CHAT_RULE}__chat_send_message`]
    expect(reviewGaps(one, [...one, CHAT_RULE], servers)).toEqual([])
    const all = writingTools(CHAT, CHAT_RULE).map((t) => t.rule)
    expect(reviewGaps(all, all, servers)).toEqual([])
    const named = ['mcp__tracker__create_issue']
    expect(reviewGaps(named, named, servers)).toEqual([])
  })
})

describe('the review rule routes', () => {
  const app = createApp()
  const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
  const added: number[] = []

  async function send(method: string, path: string, body?: unknown, auth: object = {}): Promise<Response> {
    return app.request(`/api${path}`, {
      method,
      headers: { ...headers, ...auth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async function data<T>(res: Response): Promise<T> {
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: T }).data
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const id of added.splice(0)) {
      await send('DELETE', `/permissions/rules/${String(id)}`)
    }
  })

  afterAll(async () => {
    await tasks.remove('coverage-task')
  })

  const batch = async (rules: string[]) => {
    const made = await data<PermissionRule[]>(
      await send('POST', '/permissions/rules/batch', { behavior: 'review', rules }),
    )
    added.push(...made.map((rule) => rule.id))
    return made
  }

  it('add several rules with one request and audit each', async () => {
    const rules = [`${CHAT_RULE}__chat_send_message`, `${CHAT_RULE}__chat_complete_file_upload`]
    const made = await batch(rules)
    expect(made.map((rule) => [rule.behavior, rule.rule])).toEqual(rules.map((rule) => ['review', rule]))
    await auditEvents.settled()
    const page = await auditEvents.page({ kind: 'system.permission_rule_added', limit: 2 })
    expect(new Set(page.events.map((event) => event.detail.rule))).toEqual(new Set(rules))
    expect(page.events.every((event) => event.actor === 'user')).toBe(true)
  })

  it('refuse a batch that is not MCP rules, and an empty one', async () => {
    const bad = await send('POST', '/permissions/rules/batch', { behavior: 'review', rules: ['mcp__chat', 'Bash'] })
    expect(bad.status).toBe(400)
    expect((await send('POST', '/permissions/rules/batch', { behavior: 'review', rules: [] })).status).toBe(400)
  })

  it('report the gap of a partly reviewed server and list its tools', async () => {
    vi.spyOn(capabilityCache, 'all').mockReturnValue([snapshot('2026-01-02T00:00:00.000Z', [CHAT])])
    const sent = `${CHAT_RULE}__chat_send_message`
    await batch([sent])
    const policy = await data<PermissionPolicy>(await send('GET', '/permissions'))
    expect(policy.review_gaps).toEqual([{ server: CHAT_RULE, label: 'Chat', uncovered: 3 }])
    const coverage = await data<ReviewCoverage>(await send('GET', `/permissions/rules/coverage?rule=${CHAT_RULE}`))
    expect(coverage.tools.filter((t) => !t.reviewed).map((t) => t.name)).toEqual([
      'chat_schedule_message',
      'chat_complete_file_upload',
      'chat_update_canvas',
    ])
    await batch([CHAT_RULE])
    expect((await data<PermissionPolicy>(await send('GET', '/permissions'))).review_gaps).toEqual([])
  })

  it('answer for a server no probe lists, and refuse a rule that is not an MCP name', async () => {
    const coverage = await data<ReviewCoverage>(
      await send('GET', '/permissions/rules/coverage?rule=mcp__nowhere__send'),
    )
    expect(coverage).toMatchObject({ known: false, tools: [] })
    expect((await send('GET', '/permissions/rules/coverage?rule=Bash')).status).toBe(400)
  })

  it('refuse the EA and agents, for every agent and for one', async () => {
    await tasks.insert({
      id: 'coverage-task',
      title: 'Coverage',
      repo_id: null,
      cwd: '/tmp',
      worktree: false,
      pr_urls: [],
    })
    const task = await tasks.get('coverage-task')
    if (task === undefined) {
      throw new Error('no task')
    }
    const body = { behavior: 'review' as const, rules: ['mcp__chat'] }
    expect((await send('POST', '/permissions/rules/batch', body, EA_AUTH)).status).toBe(403)
    expect((await send('POST', '/tasks/coverage-task/permissions/rules/batch', body, EA_AUTH)).status).toBe(403)
    await expect(asAgent(task, async () => addPermissionRules(null, body))).rejects.toThrow(
      'Agents cannot change permission rules',
    )
    await expect(asAgent(task, async () => addPermissionRules(task, body))).rejects.toThrow(
      'Agents cannot change permission rules',
    )
    const policy = await data<PermissionPolicy>(await send('GET', '/permissions'))
    expect(policy.rules.filter((rule) => rule.rule === 'mcp__chat')).toEqual([])
  })
})
