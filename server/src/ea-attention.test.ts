import { AWAY_MS, DEFAULT_TIERS, type AttentionState, type Task } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { buildBrief, briefSentence } from './attention-brief.js'
import { sql, tasks } from './db.js'
import { BURST_CAP, resetAttention, routeAttention, tierOfItem } from './ea-attention.js'
import { recordCall, recordFocus, resetPresence } from './presence.js'
import { eaWatches } from './store/inbox.js'
import { notificationSettings, pushDevices } from './store/notifications.js'
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

async function newTask(title: string, fields: Partial<Task> = {}): Promise<Task> {
  count += 1
  const id = `attention-task-${String(count)}`
  await tasks.insert({ id, title, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  const at = fields.updated_at ?? new Date().toISOString()
  await sql`UPDATE task SET status = ${fields.status ?? 'idle'}, closing_line = ${fields.closing_line ?? null},
    blocked = ${fields.blocked ?? null}, updated_at = ${at} WHERE id = ${id}`
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
  await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE id LIKE 'attention-task-%'`
})

describe('the attention router', () => {
  it('picks one surface: the call, a page with focus, else the phone', async () => {
    const active = { tier: 'active', viaEa: true } as const
    expect(await routeAttention(active)).toBe('push')
    recordFocus({ device_id: 'desk', agents: [], active: true })
    expect(await routeAttention(active)).toBe('toast')
    recordCall()
    expect(await routeAttention(active)).toBe('call')
    expect(await routeAttention({ ...active, callable: false })).toBe('toast')
    expect(await routeAttention({ ...active, viaEa: false })).toBe('toast')
  })

  it('follows the tier the user picked, and holds a tier for the brief while nobody can see a toast', async () => {
    expect(await routeAttention({ tier: 'digest', viaEa: true })).toBe('digest')
    expect(await routeAttention({ tier: 'passive', viaEa: true })).toBe('passive')
    await notificationSettings.set({ ...DEFAULT_TIERS, active: 'toast', passive: 'push' })
    expect(await routeAttention({ tier: 'active', viaEa: true })).toBe('digest')
    expect(await routeAttention({ tier: 'passive', viaEa: true })).toBe('push')
    await pushDevices.remove(PHONE.device_id)
    expect(await routeAttention({ tier: 'passive', viaEa: true })).toBe('digest')
  })

  it('keeps needs-you urgent and outside the burst cap', async () => {
    await notificationSettings.set({ ...DEFAULT_TIERS, active: 'off' })
    expect(await routeAttention({ tier: 'active', needsYou: true, viaEa: false })).toBe('push')
    await notificationSettings.set(DEFAULT_TIERS)
    const routes = []
    for (let i = 0; i < BURST_CAP + 2; i += 1) {
      routes.push(await routeAttention({ tier: 'active', viaEa: false }))
    }
    expect(routes.filter((route) => route === 'push')).toHaveLength(BURST_CAP - 1)
    expect(routes.at(-1)).toBe('digest')
    expect(await routeAttention({ tier: 'digest', needsYou: true, viaEa: false })).toBe('push')
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
    const done = await newTask('Speech engine', { closing_line: 'Opened PR #12; CI is green' })
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

  it("leaves out a watched agent's finished turn when its tier is off", async () => {
    const since = new Date().toISOString()
    const watched = await newTask('Watched', { closing_line: 'Shipped' })
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
