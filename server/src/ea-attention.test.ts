import { AWAY_MS, DEFAULT_TIERS, type AttentionState, type Task } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { buildBrief, briefSentence } from './attention-brief.js'
import { sql, tasks } from './db.js'
import { BURST_CAP, resetAttention, routeAttention, tierOfItem } from './ea-attention.js'
import { recordCall, recordFocus, resetPresence } from './presence.js'
import { eaInbox, eaWatches } from './store/inbox.js'
import { notificationSettings, notifyScopes, pushDevices } from './store/notifications.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const app = createApp()
const USER = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
const BOT = { ...USER, ...EA_AUTH }

async function send<T>(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const PHONE = {
  device_id: 'attention-phone',
  endpoint: 'https://fcm.googleapis.com/fcm/send/attention',
  keys: { p256dh: 'p', auth: 'a' },
  label: 'Phone',
}

let count = 0

/** One millisecond after `since`, so a turn that ends then is inside the brief on any clock. */
const justAfter = (since: string) => new Date(Date.parse(since) + 1).toISOString()

/** `ended` is when its last turn ended; left out, that is its `updated_at`. */
async function newTask(title: string, fields: Partial<Task> = {}, ended?: string): Promise<Task> {
  count += 1
  const id = `attention-task-${String(count)}`
  await tasks.insert({ id, title, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  const at = fields.updated_at ?? new Date().toISOString()
  await sql`UPDATE task SET status = ${fields.status ?? 'idle'}, closing_line = ${fields.closing_line ?? null},
    blocked = ${fields.blocked ?? null}, notifications_muted = ${fields.notifications_muted ?? false},
    updated_at = ${at}, turn_ended_at = ${ended ?? at} WHERE id = ${id}`
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('task was not stored')
  }
  return task
}

beforeEach(async () => {
  resetAttention()
  resetPresence()
  await pushDevices.put(PHONE)
})

afterEach(async () => {
  await notificationSettings.set(DEFAULT_TIERS)
  await pushDevices.remove(PHONE.device_id)
  await sql`DELETE FROM notify_scope WHERE device_id IN (${PHONE.device_id}, 'desk')`
  await sql`DELETE FROM ea_inbox WHERE task_id LIKE 'attention-task-%'`
  await sql`DELETE FROM workspace WHERE id IN ('ws-a', 'ws-b')`
  await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE id LIKE 'attention-task-%'`
})

describe('the attention router', () => {
  it('picks one surface: a page with focus, else the phone, and never the call', async () => {
    const active = { tier: 'active' } as const
    expect(await routeAttention(active)).toBe('push')
    recordCall()
    expect(await routeAttention(active)).toBe('push')
    recordFocus({ device_id: 'desk', agents: [], active: true })
    expect(await routeAttention(active)).toBe('toast')
  })

  it.each([
    { name: 'urgent on push, nobody looking', urgent: 'push', focus: false, device: true, route: 'push' },
    { name: 'urgent on toast, a page has focus', urgent: 'toast', focus: true, device: true, route: 'toast' },
    { name: 'urgent on toast, nobody looking', urgent: 'toast', focus: false, device: true, route: 'push' },
    { name: 'urgent on toast, no push device', urgent: 'toast', focus: false, device: false, route: 'digest' },
    { name: 'urgent on push, no push device', urgent: 'push', focus: false, device: false, route: 'digest' },
  ] as const)('sends needs-you to the user: $name', async ({ urgent, focus, device, route }) => {
    await notificationSettings.set({ ...DEFAULT_TIERS, urgent })
    if (!device) {
      await pushDevices.remove(PHONE.device_id)
    }
    if (focus) {
      recordFocus({ device_id: 'desk', agents: [], active: true })
    }
    expect(await routeAttention({ tier: 'active', needsYou: true })).toBe(route)
  })

  it.each([
    { name: 'the phone has the workspace open', open: 'ws-a', only: true, route: 'push' },
    { name: 'the phone keeps to another workspace', open: 'ws-b', only: true, route: 'digest' },
    { name: 'the phone hears every workspace', open: 'ws-b', only: false, route: 'push' },
  ] as const)('keeps a device to its open workspace, needs-you included: $name', async ({ open, only, route }) => {
    for (const id of ['ws-a', 'ws-b']) {
      await sql`INSERT INTO workspace (id, name, position, created_at)
        VALUES (${id}, ${id}, 99, ${new Date().toISOString()}) ON CONFLICT (id) DO NOTHING`
    }
    await notificationSettings.set({ ...DEFAULT_TIERS, urgent: 'toast' })
    await notifyScopes.set(PHONE.device_id, { workspace_id: open, workspace_only: only })
    await notifyScopes.set('desk', { workspace_id: 'ws-b', workspace_only: true })
    recordFocus({ device_id: 'desk', agents: [], active: true })
    expect(await routeAttention({ tier: 'active', needsYou: true, workspaceId: 'ws-a' })).toBe(route)
  })

  it('leaves a toast tier below urgent to the brief while nobody looks', async () => {
    await notificationSettings.set({ ...DEFAULT_TIERS, active: 'toast' })
    expect(await routeAttention({ tier: 'active' })).toBe('digest')
  })

  it('follows the tier the user picked, and holds a tier for the brief while nobody can see a toast', async () => {
    expect(await routeAttention({ tier: 'digest' })).toBe('digest')
    expect(await routeAttention({ tier: 'passive' })).toBe('passive')
    await notificationSettings.set({ ...DEFAULT_TIERS, active: 'toast', passive: 'push' })
    expect(await routeAttention({ tier: 'active' })).toBe('digest')
    expect(await routeAttention({ tier: 'passive' })).toBe('push')
    await pushDevices.remove(PHONE.device_id)
    expect(await routeAttention({ tier: 'passive' })).toBe('digest')
  })

  it('keeps needs-you urgent and outside the burst cap', async () => {
    await notificationSettings.set({ ...DEFAULT_TIERS, active: 'off' })
    expect(await routeAttention({ tier: 'active', needsYou: true })).toBe('push')
    await notificationSettings.set(DEFAULT_TIERS)
    const routes = []
    for (let i = 0; i < BURST_CAP + 2; i += 1) {
      routes.push(await routeAttention({ tier: 'active' }))
    }
    expect(routes.filter((route) => route === 'push')).toHaveLength(BURST_CAP - 1)
    expect(routes.at(-1)).toBe('digest')
    expect(await routeAttention({ tier: 'digest', needsYou: true })).toBe('push')
  })

  it('reads the tier of an inbox item from its kind, event and urgency', () => {
    expect(tierOfItem({ kind: 'watch_event', event: 'needs_you', urgent: true })).toBe('urgent')
    expect(tierOfItem({ kind: 'watch_event', event: 'turn_finished', urgent: false })).toBe('digest')
    expect(tierOfItem({ kind: 'watch_event', event: 'pr_linked', urgent: false })).toBe('passive')
    expect(tierOfItem({ kind: 'reminder', event: 'due', urgent: false })).toBe('active')
  })
})

describe('the since-you-left brief', () => {
  it('says it in one breath', () => {
    expect(briefSentence(1, 2, 0)).toBe('Two agents finished and one needs you.')
    expect(briefSentence(2, 0, 0)).toBe('Two agents need you.')
    expect(briefSentence(0, 1, 3)).toBe('One agent finished and three updates came in.')
    expect(briefSentence(1, 1, 1)).toBe('One agent finished, one update came in and one needs you.')
  })

  it('lists needs-you first, then one line per agent in its own words, and nothing when quiet', async () => {
    const since = new Date().toISOString()
    expect(await buildBrief(since, new Date().toISOString())).toBeNull()
    const old = await newTask('Older', { closing_line: 'Done long ago', updated_at: '2020-01-01T00:00:00.000Z' })
    const done = await newTask('Speech engine', {
      closing_line: 'Opened PR #12; CI is green',
      updated_at: justAfter(since),
    })
    const stuck = await newTask('Voicemail', { blocked: 'Asks to use Bash: make deploy' })
    const brief = await buildBrief(since, new Date().toISOString())
    expect(brief?.needs_you).toEqual([
      { task_id: stuck.id, title: 'Voicemail', text: 'Asks to use Bash: make deploy', url: `/#agents/${stuck.id}` },
    ])
    expect(brief?.changed).toEqual([
      { task_id: done.id, title: 'Speech engine', text: 'Opened PR #12; CI is green', url: `/#agents/${done.id}` },
    ])
    expect(brief?.changed.some((line) => line.task_id === old.id)).toBe(false)
    expect(brief?.summary).toBe('One agent finished and one needs you.')
  })

  it.each([
    { name: 'a turn that ended since', muted: false, ended: 'after', listed: true },
    { name: 'a rename or pin since, its turn long over', muted: false, ended: 'before', listed: false },
    { name: 'a muted agent whose turn ended since', muted: true, ended: 'after', listed: false },
  ] as const)('lists an agent as finished only for $name', async ({ muted, ended, listed }) => {
    const since = new Date().toISOString()
    const fields = { closing_line: 'Done', notifications_muted: muted, updated_at: justAfter(since) }
    const task = await newTask('Changed', fields, ended === 'after' ? justAfter(since) : '2020-01-01T00:00:00.000Z')
    const brief = await buildBrief(since, new Date().toISOString())
    expect(brief?.changed.some((line) => line.task_id === task.id) ?? false).toBe(listed)
  })

  it.each([
    { name: 'an agent that is not muted', muted: false, listed: true },
    { name: 'a muted agent', muted: true, listed: false },
  ] as const)('lists an inbox item about $name: $listed', async ({ muted, listed }) => {
    const since = new Date().toISOString()
    const task = await newTask('Reviewed', { status: 'running', notifications_muted: muted })
    const at = justAfter(since)
    const item = await eaInbox.add({
      kind: 'watch_event',
      event: 'ci_passed',
      title: 'CI passed on acme/web#7',
      body: '',
      url: null,
      severity: 'success',
      source: 'Reviewed',
      task_id: task.id,
      due_at: at,
      created_at: at,
    })
    await sql`UPDATE ea_inbox SET delivered_at = ${at}, route = 'digest' WHERE id = ${item.id}`
    const brief = await buildBrief(since, new Date().toISOString())
    expect(brief?.changed.some((line) => line.task_id === task.id) ?? false).toBe(listed)
  })

  it("leaves out a watched agent's finished turn when its tier is off", async () => {
    const since = new Date().toISOString()
    const watched = await newTask('Watched', { closing_line: 'Shipped', updated_at: justAfter(since) })
    await eaWatches.add(watched.id, '', since)
    await notificationSettings.set({ ...DEFAULT_TIERS, digest: 'off' })
    expect(await buildBrief(since, new Date().toISOString())).toBeNull()
    await notificationSettings.set(DEFAULT_TIERS)
    expect((await buildBrief(since, new Date().toISOString()))?.changed).toHaveLength(1)
    await eaWatches.remove(watched.id)
  })

  it('waits for the user to come back, shows on every page, and goes once dismissed or told', async () => {
    const left = Date.now() - 2 * AWAY_MS
    resetPresence(left)
    await newTask('Billing', { closing_line: 'Fixed the rounding bug' })
    recordFocus({ device_id: 'back', agents: [], active: true })
    const state = await send<AttentionState>('GET', '/attention', USER)
    expect(state.brief?.changed.map((line) => line.text)).toContain('Fixed the rounding bug')
    expect(state.brief?.since).toBe(new Date(left).toISOString())
    const id = state.brief?.id ?? ''
    expect(await send('POST', '/attention/brief/seen', USER, { id })).toEqual({ closed: true })
    expect((await send<AttentionState>('GET', '/attention', USER)).brief).toBeNull()

    resetPresence(Date.now() - 2 * AWAY_MS)
    await newTask('Docs', { closing_line: 'Rewrote the setup guide' })
    const told = await send<AttentionState>('GET', '/ea/brief', BOT)
    expect(told.brief?.summary).toMatch(/finished/)
    expect((await send<AttentionState>('GET', '/attention', USER)).brief).toBeNull()
  })

  it('names the agents the EA watches, whose toasts its inbox raises instead', async () => {
    const watched = await newTask('Watched')
    await eaWatches.add(watched.id, '', new Date().toISOString())
    expect((await send<AttentionState>('GET', '/attention', USER)).ea_tasks).toContain(watched.id)
    await eaWatches.remove(watched.id)
  })
})
