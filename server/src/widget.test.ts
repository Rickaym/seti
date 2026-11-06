import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import {
  WIDGET_LIMITS,
  type DeviceInfo,
  type DevicePaired,
  type PairingCode,
  type SubtaskBrief,
  type TaskListEntry,
  type WidgetSummary,
} from '@seti/shared'
import { SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { PublicAccess } from './config.js'
import { tasks } from './db.js'
import { auditEvents } from './store/audit.js'
import { taskListEntries } from './task-actions.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { agentRow, genericTitle, overviewOrder, prLabel, type RowContext } from './widget-rows.js'
import { widgetSummary } from './widget.js'

vi.mock('./runner.js', () => ({
  runTurn: () => undefined,
  stopTurn: async () => Promise.resolve(),
  endSession: async () => Promise.resolve(),
  isRunning: () => false,
  registerContextProvider: () => undefined,
  registerSessionMcpServers: () => undefined,
  registerTurnPreface: () => undefined,
  onTurnEnd: () => undefined,
  subscribe: () => () => undefined,
  openQuerySince: () => null,
}))

const ACCESS: PublicAccess = { hostname: 'seti.example.com', origin: 'https://seti.example.com', cloudflare: null }
const app = createApp({ access: ACCESS, verify: null })
const LOCAL = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
const SECRET_TITLE = 'Rotate the prod database password for acme-corp'
const LONG = 'x'.repeat(300)

async function call(route: string, headers: Record<string, string>, body?: unknown) {
  const [method = 'GET', path = '/'] = route.split(' ')
  return app.request(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

interface Phone {
  id: string
  key: KeyObject
}

async function pair(): Promise<Phone> {
  const { code } = await data<PairingCode>(await call('POST /api/devices/pairing', LOCAL, {}))
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const body = { code, name: 'Pixel', platform: 'android', public_key: publicKey }
  const paired = await data<DevicePaired>(await call('POST /api/devices/pair', { host: ACCESS.hostname }, body))
  return { id: paired.device_id, key: keys.privateKey }
}

async function summaryFor(phone: Phone): Promise<WidgetSummary> {
  const jws = await new SignJWT({
    htm: 'GET',
    htu: `${ACCESS.origin}/api/widget/summary`,
    jti: randomBytes(16).toString('base64url'),
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'seti-device+jwt', kid: phone.id })
    .setIssuedAt()
    .sign(phone.key)
  const headers = { host: ACCESS.hostname, authorization: `SetiDevice ${jws}` }
  return data<WidgetSummary>(await call('GET /api/widget/summary', headers))
}

let made = 0
async function agent(title: string): Promise<string> {
  made += 1
  const id = `widget-${String(made)}`
  await tasks.insert({ id, title, repo_id: null, cwd: '/', worktree: false, pr_urls: [] })
  return id
}

const entryOf = async (id: string): Promise<TaskListEntry> => {
  const entry = (await taskListEntries()).find((candidate) => candidate.id === id)
  if (entry === undefined) {
    throw new Error(`no entry ${id}`)
  }
  return entry
}

const subtask = (n: number): SubtaskBrief => ({
  tool_use_id: `toolu_${String(n)}`,
  tool_use_ids: [`toolu_${String(n)}`],
  parent_tool_use_id: null,
  message_id: n,
  sdk_task_id: null,
  description: `Look for the ${LONG}`,
  subagent_type: 'Explore',
  background: false,
  status: 'running',
  progress: { description: 'x', last_tool: 'mcp__github__get_pull_request', summary: null },
  usage: null,
  started_at: new Date().toISOString(),
  ended_at: null,
  summary: null,
  pr_urls: [],
})

const PR = 'https://github.com/acme/seti/pull/412'
const ctx = (showNames: boolean, workspace = ''): RowContext => ({
  showNames,
  openPrs: new Map([[PR, { ci: 'failure', unresolved_threads: 2 }]]),
  workspaces: new Map([[workspace, 'Platform team']]),
  ownTool: () => 'Bash',
})

describe('widget summary', () => {
  it('lists blocked agents with their reason line, and caps every list and line', async () => {
    const blocked = await agent(LONG)
    await tasks.setBlocked(blocked, 'Asks to use Bash: terraform apply')
    const asking: string[] = []
    for (let i = 0; i < WIDGET_LIMITS.waiting + 3; i += 1) {
      asking.push(await agent(`Asking ${String(i)}`))
      await tasks.endTurn(asking[i] ?? '', { status: 'idle', last_error: null, asking: true, closing_line: null })
    }
    const summary = await widgetSummary({ showNames: true })
    expect(summary.needs_you).toHaveLength(WIDGET_LIMITS.waiting)
    expect(summary.needs_you_count).toBe(WIDGET_LIMITS.waiting + 4)
    expect(summary.agents.length).toBeLessThanOrEqual(WIDGET_LIMITS.agents)
    const first = summary.needs_you[0]
    expect(first).toMatchObject({ task_id: blocked, reason: 'blocked', line: 'Asks to use Bash: terraform apply' })
    expect(first?.title.length).toBeLessThanOrEqual(WIDGET_LIMITS.title)
    expect(summary.needs_you.find((row) => row.reason === 'asking')?.line).toBe('Asks you')
    expect(summary.names_hidden).toBe(false)
    await tasks.setBlocked(blocked, null)
    await Promise.all(asking.map(async (id) => tasks.markSeen(id)))
  })

  it('shows what a running agent does: its tool, todo step, subagents and most telling PR', async () => {
    const id = await agent('Ship the widget')
    await tasks.setStatus(id, 'running', null)
    const entry = {
      ...(await entryOf(id)),
      running_subtasks: [1, 2, 3, 4, 5].map(subtask),
      todos: [
        { id: '1', content: 'Plan', active_form: null, status: 'completed' as const },
        { id: '2', content: 'Write tests', active_form: 'Writing tests', status: 'in_progress' as const },
        { id: '3', content: 'Ship', active_form: null, status: 'pending' as const },
      ],
      pr_urls: ['https://github.com/acme/seti/pull/1', PR],
      pr_states: { by_url: { [PR]: 'open' as const }, any_merged: false },
    }
    const row = agentRow(entry, ctx(true, entry.workspace_id), null)
    expect(row).toMatchObject({
      state: 'running',
      activity: 'Writing tests',
      tool: 'Bash',
      todos: { done: 1, total: 3 },
      more_subagents: 2,
      pr: { label: 'seti#412', ci: 'failure', unresolved_threads: 2, more: 1 },
      workspace: 'Platform team',
    })
    expect(row.subagents).toHaveLength(WIDGET_LIMITS.subagents)
    expect(row.subagents[0]?.tool).toBe('github: get_pull_request')
    expect(row.subagents[0]?.label.length).toBeLessThanOrEqual(WIDGET_LIMITS.label)
  })

  it('orders running agents first and drops idle ones that have not changed for a day', async () => {
    const id = await agent('Old idle work')
    const old = { ...(await entryOf(id)), updated_at: new Date(Date.now() - 86_400_000).toISOString() }
    const running = { ...(await entryOf(id)), id: 'running', status: 'running' as const }
    const fresh = { ...(await entryOf(id)), id: 'fresh' }
    expect(overviewOrder([fresh, old, running], Date.now()).map((entry) => entry.id)).toEqual(['running', 'fresh'])
  })

  it('names PRs by repo and number', () => {
    expect(prLabel(PR)).toBe('seti#412')
  })
})

describe('show names on widgets', () => {
  it('replaces titles and free text with generic labels on a device that hides names', async () => {
    const phone = await pair()
    const id = await agent(SECRET_TITLE)
    await tasks.setBlocked(id, 'Asks to use Bash: psql -c "drop table customers"')
    expect((await summaryFor(phone)).needs_you.find((row) => row.task_id === id)?.title).toBe(SECRET_TITLE)

    const changed = await data<DeviceInfo>(
      await call(`PUT /api/devices/${phone.id}/widget`, LOCAL, { show_names: false }),
    )
    expect(changed.show_names).toBe(false)
    expect(await auditEvents.latest('system.device_widget_changed')).toMatchObject({
      subject_id: phone.id,
      detail: { show_names: false },
    })
    const hidden = await summaryFor(phone)
    const text = JSON.stringify(hidden)
    expect(hidden.names_hidden).toBe(true)
    expect(text).not.toContain('prod database')
    expect(text).not.toContain('drop table')
    expect(hidden.needs_you.find((row) => row.task_id === id)).toMatchObject({
      title: genericTitle(id),
      line: 'Waits for your approval',
    })
    const entry = { ...(await entryOf(id)), running_subtasks: [subtask(1)], pr_urls: [PR] }
    const row = agentRow(entry, ctx(false, entry.workspace_id), null)
    expect(row).toMatchObject({
      workspace: null,
      pr: { label: null, ci: 'failure' },
      subagents: [{ label: 'Explore' }],
    })
  })

  it('keeps names on for a new phone and lets only the user change the setting', async () => {
    const phone = await pair()
    const listed = await data<DeviceInfo[]>(await call('GET /api/devices', LOCAL))
    expect(listed.find((device) => device.id === phone.id)?.show_names).toBe(true)
    const ea = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...EA_AUTH }
    expect((await call(`PUT /api/devices/${phone.id}/widget`, ea, { show_names: false })).status).toBe(403)
    expect((await call(`PUT /api/devices/${phone.id}/widget`, LOCAL, { show_names: 'no' })).status).toBe(400)
    expect((await summaryFor(phone)).names_hidden).toBe(false)
  })
})
