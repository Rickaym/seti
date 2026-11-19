import { createECDH, randomBytes } from 'node:crypto'
import {
  auditQuery,
  DEFAULT_NOTIFY_SCOPE,
  hearsWorkspace,
  type EaInboxItem,
  type NotificationStatus,
  type NotifyScope,
  type NotifyScopeInput,
  type Task,
  type Workspace,
} from '@seti/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { resetAttention } from './ea-attention.js'
import { notifyAgent, pushEaItem, pushToEveryDevice } from './notifications.js'
import { recordFocus, resetPresence } from './presence.js'
import { auditEvents } from './store/audit.js'
import { USER_AUTH } from './test-auth.js'

const app = createApp()

async function send(method: string, url: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 204) {
    return { status: 204, data: undefined }
  }
  return { status: res.status, data: ((await res.json()) as { data: unknown }).data }
}

let made = 0

/** A device with push on, by its id; its endpoint ends in the same id. */
async function device(): Promise<string> {
  made += 1
  const id = `scope-device-${String(made).padStart(4, '0')}`
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const subscription = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  }
  expect((await send('PUT', `/notifications/devices/${id}`, { subscription, label: `Phone ${id}` })).status).toBe(200)
  return id
}

const setScope = async (id: string, change: NotifyScopeInput) =>
  send('PUT', `/notifications/devices/${id}/scope`, change)

async function agentIn(workspace: Workspace, change: Partial<Pick<Task, 'notifications_muted'>> = {}): Promise<Task> {
  made += 1
  const id = `scope-task-${String(made)}`
  await tasks.insert({ id, title: `Agent ${String(made)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  const moved = await send('PATCH', `/tasks/${id}`, { workspace_id: workspace.id, ...change })
  expect(moved.status).toBe(200)
  return moved.data as Task
}

let pushed: string[] = []
let a: Workspace
let b: Workspace

beforeAll(async () => {
  a = (await send('POST', '/workspaces', { name: 'Scope A' })).data as Workspace
  b = (await send('POST', '/workspaces', { name: 'Scope B' })).data as Workspace
})

beforeEach(() => {
  pushed = []
  resetAttention()
  resetPresence()
  vi.stubGlobal('fetch', async (url: string) => {
    pushed.push(url.split('/').at(-1) ?? '')
    return Promise.resolve(new Response(null, { status: 201 }))
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const { device_id } of ((await send('GET', '/notifications')).data as NotificationStatus).devices) {
    await send('DELETE', `/notifications/devices/${device_id}`)
  }
})

describe('who hears about a workspace', () => {
  const scope = (workspace_id: string | null, workspace_only: boolean): NotifyScope => ({
    workspace_id,
    workspace_only,
  })

  it.each([
    { name: 'the open workspace', scope: scope('b', true), agent: 'b', hears: true },
    { name: 'another workspace', scope: scope('b', true), agent: 'a', hears: false },
    { name: 'another workspace with the setting off', scope: scope('b', false), agent: 'a', hears: true },
    { name: 'the open workspace with the setting off', scope: scope('b', false), agent: 'b', hears: true },
    { name: 'a device that never reported a workspace', scope: DEFAULT_NOTIFY_SCOPE, agent: 'a', hears: true },
    { name: 'no workspace reported and the setting off', scope: scope(null, false), agent: 'a', hears: true },
    { name: 'a notice about no one agent', scope: scope('b', true), agent: null, hears: true },
    { name: 'a notice about no one agent, setting off', scope: scope('b', false), agent: null, hears: true },
  ])('$name: $hears', ({ scope: given, agent, hears }) => {
    expect(hearsWorkspace(given, agent)).toBe(hears)
  })
})

describe('push by workspace', () => {
  it.each([
    { open: 'b', only: true, agent: 'b', muted: false, sent: 1 },
    { open: 'b', only: true, agent: 'a', muted: false, sent: 0 },
    { open: 'b', only: false, agent: 'a', muted: false, sent: 1 },
    { open: 'a', only: true, agent: 'a', muted: false, sent: 1 },
    { open: null, only: true, agent: 'a', muted: false, sent: 1 },
    { open: null, only: false, agent: 'b', muted: false, sent: 1 },
    { open: 'b', only: true, agent: 'b', muted: true, sent: 0 },
    { open: 'b', only: false, agent: 'a', muted: true, sent: 0 },
    { open: null, only: true, agent: 'a', muted: true, sent: 0 },
  ] as const)('device on $open, only $only, agent in $agent, muted $muted: $sent', async (row) => {
    const spaces = { a, b }
    const phone = await device()
    if (row.open !== null) {
      await setScope(phone, { workspace_id: spaces[row.open].id })
    }
    if (!row.only) {
      await setScope(phone, { workspace_only: false })
    }
    const agent = await agentIn(spaces[row.agent], { notifications_muted: row.muted })
    expect(await notifyAgent(agent, 'needs_you')).toBe(row.sent)
    expect(pushed).toEqual(row.sent === 1 ? [phone] : [])
  })

  it('gives two devices on different workspaces each their own, at once after a switch', async () => {
    const [onA, onB] = [await device(), await device()]
    await setScope(onA, { workspace_id: a.id })
    await setScope(onB, { workspace_id: b.id })
    await notifyAgent(await agentIn(a), 'needs_you')
    await notifyAgent(await agentIn(b), 'finished')
    expect(pushed).toEqual([onA, onB])

    await setScope(onB, { workspace_id: a.id })
    await notifyAgent(await agentIn(a), 'needs_you')
    expect(new Set(pushed.slice(2))).toEqual(new Set([onA, onB]))
    expect(pushed).toHaveLength(4)
  })

  it("uses the agent's workspace when it sends, so a moved agent follows its new one", async () => {
    const phone = await device()
    await setScope(phone, { workspace_id: b.id })
    const agent = await agentIn(a)
    expect(await notifyAgent(agent, 'needs_you')).toBe(0)
    const moved = (await send('PATCH', `/tasks/${agent.id}`, { workspace_id: b.id })).data as Task
    expect(await notifyAgent(moved, 'finished')).toBe(1)
  })

  it('lets a focused page hold the push only when that page hears about the agent', async () => {
    const [desk, phone] = [await device(), await device()]
    await setScope(desk, { workspace_id: b.id })
    await setScope(phone, { workspace_id: a.id })
    recordFocus({ device_id: desk, agents: [], active: true })
    expect(await notifyAgent(await agentIn(a), 'needs_you')).toBe(1)
    expect(pushed).toEqual([phone])
    expect(await notifyAgent(await agentIn(b), 'needs_you')).toBe(0)
    await setScope(desk, { workspace_only: false })
    expect(await notifyAgent(await agentIn(a), 'needs_you')).toBe(0)
    expect(pushed).toEqual([phone])
  })

  it('sends notices about no one agent to every device, and an EA item about an agent by workspace', async () => {
    const [onA, onB] = [await device(), await device()]
    await setScope(onA, { workspace_id: a.id })
    await setScope(onB, { workspace_id: b.id })
    const payload = { title: 'Seti', body: 'A mod has an update', tag: 'mod-update', url: '/', kind: 'mod_update' }
    expect(await pushToEveryDevice({ ...payload, kind: 'mod_update' })).toBe(2)
    const item = { id: 1, source: 'Channel', title: 'An alert', urgent: false, task_id: null } as EaInboxItem
    expect(await pushEaItem(item)).toBe(2)
    pushed = []
    expect(await pushEaItem({ ...item, id: 2, task_id: (await agentIn(b)).id })).toBe(1)
    expect(pushed).toEqual([onB])
  })
})

describe('the device scope route', () => {
  const changes = async () =>
    (await auditEvents.page(auditQuery.parse({ kind: 'system.notifications_changed', limit: 50 }))).events

  it('records the open workspace without an audit entry and audits the setting', async () => {
    const phone = await device()
    const before = (await changes()).length
    expect((await setScope(phone, { workspace_id: b.id })).data).toEqual({ workspace_id: b.id, workspace_only: true })
    expect((await setScope(phone, { workspace_id: a.id })).data).toEqual({ workspace_id: a.id, workspace_only: true })
    expect(await changes()).toHaveLength(before)

    expect((await setScope(phone, { workspace_only: false })).data).toEqual({
      workspace_id: a.id,
      workspace_only: false,
    })
    expect((await setScope(phone, { workspace_only: false })).status).toBe(200)
    expect((await setScope(phone, { workspace_id: b.id })).data).toEqual({ workspace_id: b.id, workspace_only: false })
    const after = await changes()
    expect(after).toHaveLength(before + 1)
    expect(after[0]).toMatchObject({
      actor: 'user',
      summary: `Notifications of Phone ${phone} cover every workspace`,
      detail: { workspace_only: false },
    })
    await setScope(phone, { workspace_only: true })
    expect((await changes())[0]?.summary).toBe(`Notifications of Phone ${phone} keep to its open workspace`)
  })

  it('keeps the setting of a device without push, and refuses bad input', async () => {
    const tab = 'scope-browser-tab'
    expect((await setScope(tab, { workspace_only: false })).data).toEqual({ workspace_id: null, workspace_only: false })
    expect((await changes())[0]?.summary).toBe('Notifications of a device without push cover every workspace')
    expect((await setScope(tab, { workspace_id: 'no-such-workspace' })).status).toBe(404)
    expect((await send('PUT', `/notifications/devices/${tab}/scope`, { workspace_only: 'yes' })).status).toBe(400)
    expect((await send('PUT', '/notifications/devices/short/scope', { workspace_only: true })).status).toBe(400)
  })

  it('counts a device as on every workspace once its workspace is deleted', async () => {
    const gone = (await send('POST', '/workspaces', { name: 'Scope gone' })).data as Workspace
    const phone = await device()
    await setScope(phone, { workspace_id: gone.id })
    expect((await send('DELETE', `/workspaces/${gone.id}`)).status).toBe(204)
    expect((await setScope(phone, {})).data).toEqual({ workspace_id: null, workspace_only: true })
    expect(await notifyAgent(await agentIn(a), 'needs_you')).toBe(1)
  })
})
