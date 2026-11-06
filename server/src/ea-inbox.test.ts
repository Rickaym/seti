import type {
  ChannelEvent,
  EaFollowup,
  EaHistoryPage,
  EaInboxDelivered,
  EaInboxItem,
  EaInboxUnread,
  EaFollowupInput,
} from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { EA_ABSENT_MS, eaPolled, sweepInbox } from './ea-deliver.js'
import { routeChannelEvent, scheduleFollowup } from './ea-inbox.js'
import { auditEvents } from './store/audit.js'
import { eaHistory } from './store/ea.js'
import { eaInbox } from './store/inbox.js'
import { USER_AUTH, EA_AUTH } from './test-auth.js'

const app = createApp()
const LOCAL = { host: '127.0.0.1:3006', ...USER_AUTH, origin: 'http://127.0.0.1:3006' }
const BOT = { ...LOCAL, ...EA_AUTH }

async function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return app.request(`/api/ea${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const schedule = async (input: EaFollowupInput) => data<EaFollowup>(await send('POST', '/followups', BOT, input))

/** Pushes an item's due time into the past, as if its time had come. */
async function makeDue(id: number) {
  await sql`UPDATE ea_inbox SET due_at = ${new Date(Date.now() - 1000).toISOString()} WHERE id = ${id}`
}

const due = async () => data<EaInboxItem[]>(await send('GET', '/inbox/due', BOT))
const deliver = async (ids: number[], via: 'voice' | 'chat') =>
  data<EaInboxDelivered>(await send('POST', '/inbox/deliver', BOT, { ids, via }))

beforeEach(async () => {
  await sql`DELETE FROM ea_inbox`
  await eaHistory.clear()
})

describe('follow-ups', () => {
  it('schedules in the user timezone, lists soonest first and audits as the EA', async () => {
    const later = await schedule({ when: 'in 2 hours', note: 'Check the release', timezone: 'Europe/Berlin' })
    const soon = await schedule({ kind: 'reminder', when: 'in 5 minutes', note: 'Stretch', timezone: 'UTC+02:00' })
    expect(later).toMatchObject({
      kind: 'followup',
      title: 'Check the release',
      source: 'EA',
      timezone: 'Europe/Berlin',
    })
    expect(later.local_due).toMatch(/^\w+day \d\d:\d\d \(Europe\/Berlin\)$/)
    expect(soon.timezone).toBe('+02:00')
    const listed = await data<EaFollowup[]>(await send('GET', '/followups', LOCAL))
    expect(listed.map((item) => item.id)).toEqual([soon.id, later.id])
    expect(await auditEvents.latest('ea.followup_scheduled')).toMatchObject({
      actor: 'user',
      detail: { kind: 'reminder', note: 'Stretch', via: 'ea' },
    })
  })

  it('names the task a follow-up is about and refuses unknown tasks, times and zones', async () => {
    await tasks.insert({
      id: 'inbox-task-1',
      title: 'Voicemail',
      repo_id: null,
      cwd: '/tmp',
      worktree: false,
      pr_urls: [],
    })
    const item = await schedule({ when: 'at 23:59', note: 'Check CI', task_id: 'inbox-task-1', timezone: 'UTC' })
    expect(item).toMatchObject({ task_id: 'inbox-task-1', source: 'Voicemail' })
    const bad = async (input: EaFollowupInput, status: number, text: RegExp) => {
      const res = await send('POST', '/followups', BOT, input)
      expect(res.status).toBe(status)
      expect(await res.text()).toMatch(text)
    }
    await bad({ when: 'in 5 minutes', note: 'x', task_id: 'missing' }, 404, /Task not found/)
    await bad({ when: 'soonish', note: 'x' }, 400, /Could not read/)
    await bad({ when: 'at 15:00', note: 'x', timezone: 'Mars/Base' }, 400, /Unknown timezone/)
    await bad({ when: 'in 60 days', note: 'x' }, 400, /30 days/)
  })

  it('chains follow-ups only a few deep', async () => {
    let parent = await schedule({ when: 'in 1 minute', note: 'Check 0' })
    for (let depth = 1; depth <= 3; depth++) {
      parent = await schedule({ when: 'in 1 minute', note: `Check ${String(depth)}`, parent_id: parent.id })
    }
    const res = await send('POST', '/followups', BOT, { when: 'in 1 minute', note: 'Check 4', parent_id: parent.id })
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/chain at most 3 deep/)
  })

  it('cancels what has not gone out, once', async () => {
    const item = await schedule({ when: 'in 10 minutes', note: 'Check the deploy' })
    expect(
      (await data<EaFollowup>(await send('DELETE', `/followups/${String(item.id)}`, BOT))).cancelled_at,
    ).not.toBeNull()
    expect((await send('DELETE', `/followups/${String(item.id)}`, BOT)).status).toBe(404)
    await makeDue(item.id)
    expect(await due()).toEqual([])
    expect(await data<EaFollowup[]>(await send('GET', '/followups', LOCAL))).toEqual([])
    expect(await auditEvents.latest('ea.followup_cancelled')).toMatchObject({ detail: { id: item.id, via: 'ea' } })
  })
})

describe('delivery', () => {
  it('lists only due items and only to the EA bot', async () => {
    const now = await schedule({ when: 'in 1 minute', note: 'Now' })
    await schedule({ when: 'in 1 hour', note: 'Later' })
    await makeDue(now.id)
    expect((await send('GET', '/inbox/due', LOCAL)).status).toBe(403)
    expect((await send('POST', '/inbox/deliver', LOCAL, { ids: [now.id], via: 'chat' })).status).toBe(403)
    expect((await due()).map((item) => item.title)).toEqual(['Now'])
  })

  it('delivers an item once, as an inbox entry the chat shows with its notice', async () => {
    const item = await schedule({ when: 'in 1 minute', note: 'Check the voicemail PR', timezone: 'Europe/Berlin' })
    await makeDue(item.id)
    const [first, second] = await Promise.all([deliver([item.id], 'chat'), deliver([item.id], 'chat')])
    const winners = [first, second].filter((result) => result.items.length > 0)
    expect(winners).toHaveLength(1)
    const [entry] = winners[0]?.entries ?? []
    expect(entry).toMatchObject({ kind: 'inbox', message: { role: 'developer' } })
    expect(entry?.message.content).toMatch(/^Inbox: a follow-up you scheduled for .* is due: Check the voicemail PR\.$/)
    expect(await due()).toEqual([])
    const page = await data<EaHistoryPage>(await send('GET', '/history', LOCAL))
    expect(page.entries.map((e) => e.notice?.title)).toEqual(['Check the voicemail PR'])
    expect(await auditEvents.latest('ea.inbox_delivered')).toMatchObject({
      actor: 'system',
      detail: { via: 'ea', surface: 'chat', kinds: ['followup'] },
    })
  })

  it('counts chat deliveries as unread until the chat is opened; spoken ones as heard', async () => {
    const a = await schedule({ when: 'in 1 minute', note: 'A' })
    const b = await schedule({ when: 'in 1 minute', note: 'B' })
    const c = await schedule({ when: 'in 1 minute', note: 'C' })
    await Promise.all([a, b, c].map(async (item) => makeDue(item.id)))
    const unread = async () => data<EaInboxUnread>(await send('GET', '/inbox/unread', LOCAL))
    expect(await unread()).toEqual({ unread: 0, waiting: 3 })
    await deliver([a.id], 'voice')
    await deliver([b.id], 'chat')
    expect(await unread()).toEqual({ unread: 1, waiting: 1 })
    expect(await data<{ acknowledged: number }>(await send('POST', '/inbox/read', LOCAL, {}))).toEqual({
      acknowledged: 1,
    })
    expect(await unread()).toEqual({ unread: 0, waiting: 1 })
  })

  it('keeps due items through a restart and fires each once after it', async () => {
    const item = await scheduleFollowup(
      { kind: 'followup', when: 'in 1 minute', note: 'Survives', timezone: 'UTC' },
      new Date(Date.now() - 5 * 60_000),
    )
    vi.resetModules()
    const fresh = await import('./ea-deliver.js')
    const store = await import('./store/inbox.js')
    const waiting = await store.eaInbox.due(new Date().toISOString(), 10)
    expect(waiting.map((row) => row.id)).toEqual([item.id])
    expect((await fresh.deliverInbox([item.id], 'chat')).items).toHaveLength(1)
    expect((await fresh.deliverInbox([item.id], 'chat')).items).toHaveLength(0)
    expect(await store.eaInbox.due(new Date().toISOString(), 10)).toEqual([])
  })
})

describe('with the EA away', () => {
  const event = async (kind: 'watch_event' | 'channel_event', title: string) => {
    const at = new Date(Date.now() - 1000).toISOString()
    return eaInbox.add({
      kind,
      event: 'turn_finished',
      title,
      body: '',
      url: null,
      severity: 'success',
      source: 'Voicemail',
      task_id: null,
      due_at: at,
      created_at: at,
    })
  }

  it('posts events and reminders itself, and leaves follow-ups for the EA', async () => {
    const watched = await event('watch_event', 'Voicemail finished its turn')
    const reminder = await schedule({ kind: 'reminder', when: 'in 1 minute', note: 'Review the release' })
    const followup = await schedule({ when: 'in 1 minute', note: 'Check CI' })
    await Promise.all([reminder, followup].map(async (item) => makeDue(item.id)))
    const later = new Date(Date.now() + EA_ABSENT_MS + 1000)
    expect(await sweepInbox(later)).toBe(2)
    const left = await eaInbox.due(later.toISOString(), 10)
    expect(left.map((item) => item.id)).toEqual([followup.id])
    expect((await eaInbox.get(watched.id))?.delivered_via).toBe('seti')
    expect(await eaInbox.unread(later.toISOString())).toEqual({ unread: 2, waiting: 1 })
  })

  it('leaves everything to the EA while it keeps asking', async () => {
    await event('channel_event', 'api is down')
    eaPolled()
    expect(await sweepInbox(new Date(Date.now() + 1000))).toBe(0)
  })
})

describe('urgency', () => {
  const channelEvent = async (
    title: string,
    severity: ChannelEvent['severity'],
    state: ChannelEvent['state'],
    act = false,
  ) =>
    routeChannelEvent(
      {
        id: 1,
        channel: 'hooks',
        source: 'Uptime',
        severity,
        title,
        detail: '',
        url: null,
        kind: '',
        dedupe_key: title,
        subject: state === null ? null : 'api',
        state,
        occurred_at: '2026-09-28T12:00:00.000Z',
        created_at: '2026-09-28T12:00:00.000Z',
      },
      act,
    )

  it('marks an alert from an act subscription for the EA to hand on, in the item and its note', async () => {
    await channelEvent('dana asks about SSO', 'info', null, true)
    await channelEvent('deploy done', 'info', null)
    const items = await due()
    expect(items.map((item) => [item.title, item.act])).toEqual([
      ['dana asks about SSO', true],
      ['deploy done', false],
    ])
    const { entries } = await deliver(
      items.map((item) => item.id),
      'chat',
    )
    expect(entries.map((entry) => entry.message.content)).toEqual([
      'Inbox: Uptime alert (info) (act: hand its work to an existing agent without asking): dana asks about SSO.',
      'Inbox: Uptime alert (info): deploy done.',
    ])
  })

  it('marks critical channel events and subjects going down as urgent, the rest ordinary', async () => {
    await channelEvent('build broke', 'critical', null)
    await channelEvent('api is down', 'warning', 'down')
    await channelEvent('api answered slowly', 'warning', null)
    await channelEvent('no severity, but down', 'info', 'down')
    await channelEvent('api is back', 'success', 'up')
    const items = await due()
    expect(Object.fromEntries(items.map((item) => [item.title, item.urgent]))).toEqual({
      'build broke': true,
      'api is down': true,
      'api answered slowly': false,
      'no severity, but down': false,
      'api is back': false,
    })
    expect(items.every((item) => item.message_id === null)).toBe(true)
  })

  it('keeps follow-ups and reminders ordinary', async () => {
    const item = await schedule({ kind: 'reminder', when: 'in 1 minute', note: 'Stretch' })
    expect(item.urgent).toBe(false)
  })
})
