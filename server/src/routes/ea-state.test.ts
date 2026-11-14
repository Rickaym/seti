import type { EaHistoryEntry, EaHistoryPage, EaLlmMessage, EaSettings } from '@seti/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { CloudflareAccess, PublicAccess } from '../config.js'
import { auditEvents } from '../store/audit.js'
import { eaHistory } from '../store/ea.js'
import { USER_AUTH, EA_AUTH } from '../test-auth.js'

const CLOUDFLARE: CloudflareAccess = { team: 'myteam.cloudflareaccess.com', aud: 'a'.repeat(64), allowed: null }
const ACCESS: PublicAccess = {
  hostname: 'seti.example.com',
  origin: 'https://seti.example.com',
  cloudflare: CLOUDFLARE,
}

const app = createApp({ access: ACCESS, verify: async () => Promise.resolve('me@example.com') })

const LOCAL = { host: '127.0.0.1:3006', ...USER_AUTH, origin: 'http://127.0.0.1:3006' }
const BOT = { ...LOCAL, ...EA_AUTH }
const PUBLIC = {
  host: 'seti.example.com',
  origin: 'https://seti.example.com',
  'cf-access-jwt-assertion': 'token',
}

async function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return app.request(`/api/ea${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const say = (content: string): EaLlmMessage => ({ role: 'user', content })
const reply = (content: string): EaLlmMessage => ({ role: 'assistant', content })
const call: EaLlmMessage = {
  role: 'assistant',
  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_tasks', arguments: '{}' } }],
}
const result: EaLlmMessage = { role: 'tool', tool_call_id: 'call_1', content: '"Two tasks running."' }

async function append(...messages: { kind: 'message' | 'chat' | 'call'; message: EaLlmMessage }[]) {
  return (await data<{ ids: number[] }>(await send('POST', '/history/messages', BOT, { entries: messages }))).ids
}

const asMessage = (message: EaLlmMessage) => ({ kind: 'message' as const, message })

beforeEach(async () => {
  await eaHistory.clear()
})

describe('EA history', () => {
  it('appends entries in order and pages the newest ones', async () => {
    const ids = await append(
      { kind: 'call', message: { role: 'developer', content: 'A new call started.' } },
      asMessage(say('How many tasks?')),
      asMessage(call),
      asMessage(result),
      asMessage(reply('Two running.')),
    )
    expect(ids).toHaveLength(5)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))

    const page = await data<EaHistoryPage>(await send('GET', '/history', LOCAL))
    expect(page.has_older).toBe(false)
    expect(page.entries.map((e) => e.kind)).toEqual(['call', 'message', 'message', 'message', 'message'])
    expect(page.entries[2]?.message).toEqual(call)
    expect(page.entries[3]?.message).toEqual(result)

    const last = await data<EaHistoryPage>(await send('GET', '/history?limit=2', LOCAL))
    expect(last.has_older).toBe(true)
    expect(last.entries.map((e) => e.message)).toEqual([result, reply('Two running.')])
  })

  it('loads the latest summary and what follows it as the bot context', async () => {
    const [first, second, third, fourth] = await append(
      asMessage(say('one')),
      asMessage(reply('two')),
      asMessage(say('three')),
      asMessage(reply('four')),
    )
    const summary = await data<EaHistoryEntry>(
      await send('PUT', '/history/summary', BOT, { summary: 'They counted to two.', through_id: second }),
    )
    expect(summary).toMatchObject({ kind: 'summary', through_id: second, message: say('They counted to two.') })
    const [fifth] = await append(asMessage(say('five')))

    const context = await data<EaHistoryPage>(await send('GET', '/history?scope=context', BOT))
    expect(context.entries.map((e) => e.id)).toEqual([summary.id, third, fourth, fifth])

    const all = await data<EaHistoryPage>(await send('GET', '/history', LOCAL))
    expect(all.entries.map((e) => e.id)).toEqual([first, second, third, fourth, summary.id, fifth])

    const next = await data<EaHistoryEntry>(
      await send('PUT', '/history/summary', BOT, { summary: 'Counted to four.', through_id: fourth }),
    )
    const later = await data<EaHistoryPage>(await send('GET', '/history?scope=context', BOT))
    expect(later.entries.map((e) => e.id)).toEqual([next.id, fifth])
  })

  it('keeps typed turns apart from spoken ones and pages back from an entry', async () => {
    const ids = await append(
      asMessage(say('Spoken.')),
      { kind: 'chat', message: say('Typed.') },
      { kind: 'chat', message: reply('Typed back.') },
      asMessage(say('Spoken again.')),
    )
    const all = await data<EaHistoryPage>(await send('GET', '/history', LOCAL))
    expect(all.entries.map((e) => e.kind)).toEqual(['message', 'chat', 'chat', 'message'])

    const before = await data<EaHistoryPage>(await send('GET', `/history?limit=2&before=${String(ids[3])}`, LOCAL))
    expect(before.entries.map((e) => e.id)).toEqual([ids[1], ids[2]])
    expect(before.has_older).toBe(true)
    const first = await data<EaHistoryPage>(await send('GET', `/history?limit=2&before=${String(ids[1])}`, LOCAL))
    expect(first.entries.map((e) => e.id)).toEqual([ids[0]])
    expect(first.has_older).toBe(false)
  })

  it('never interleaves the ids of batches written at the same time', async () => {
    const batch = (label: string) => Array.from({ length: 20 }, (_, n) => asMessage(say(`${label} ${String(n)}`)))
    const [a, b] = await Promise.all([append(...batch('a')), append(...batch('b'))])
    const contiguous = (ids: number[]) => ids.every((id, n) => n === 0 || id === (ids[n - 1] ?? 0) + 1)
    expect(contiguous(a)).toBe(true)
    expect(contiguous(b)).toBe(true)
  })

  it('refuses a summary of entries that are gone', async () => {
    const [id] = await append(asMessage(say('hello')))
    await send('DELETE', '/history', LOCAL)
    const res = await send('PUT', '/history/summary', BOT, { summary: 'Hello.', through_id: id })
    expect(res.status).toBe(409)
    expect((await eaHistory.page(10)).entries).toEqual([])
  })

  it('validates what the bot writes', async () => {
    const bad = [
      { entries: [] },
      { entries: [{ kind: 'summary', message: say('x') }] },
      { entries: [{ kind: 'message', message: { role: 'system', content: 'x' } }] },
      { entries: [{ kind: 'message', message: { role: 'tool', content: 'x' } }] },
      { entries: [{ kind: 'message', message: { role: 'assistant', tool_calls: [] } }] },
    ]
    for (const body of bad) {
      expect((await send('POST', '/history/messages', BOT, body)).status).toBe(400)
    }
    expect((await send('PUT', '/history/summary', BOT, { summary: ' ', through_id: 1 })).status).toBe(400)
    expect((await eaHistory.page(10)).entries).toEqual([])
  })

  it('lets only the bot on loopback write the history', async () => {
    const body = { entries: [asMessage(say('hi'))] }
    expect((await send('POST', '/history/messages', LOCAL, body)).status).toBe(403)
    expect((await send('POST', '/history/messages', { ...PUBLIC, ...EA_AUTH }, body)).status).toBe(403)
    expect((await send('POST', '/history/messages', { ...LOCAL, 'x-seti-via': 'user' }, body)).status).toBe(403)
    expect((await send('PUT', '/history/summary', LOCAL, { summary: 'x', through_id: 1 })).status).toBe(403)
    expect((await eaHistory.page(10)).entries).toEqual([])
    expect((await send('GET', '/history', PUBLIC)).status).toBe(200)
  })

  it('clears the conversation as an audited user action', async () => {
    await append(asMessage(say('hello')), asMessage(reply('Evening.')))
    const cleared = await data<{ cleared: number }>(await send('DELETE', '/history', LOCAL))
    expect(cleared).toEqual({ cleared: 2 })
    expect(await eaHistory.page(10)).toEqual({ entries: [], has_older: false })
    expect(await auditEvents.latest('ea.history_cleared')).toMatchObject({
      actor: 'user',
      subject_type: 'ea',
      summary: 'Started a new EA conversation',
      detail: { entries: 2 },
    })
    const [next] = await append(asMessage(say('again')))
    expect(next).toBeGreaterThan(0)
    expect((await eaHistory.page(10)).entries.map((e) => e.id)).toEqual([next])
  })
})

describe('EA settings', () => {
  it('starts with the wake word off and saves changes with an audit entry', async () => {
    const initial = await data<EaSettings>(await send('GET', '/settings', LOCAL))
    expect(initial).toEqual({
      wake_enabled: false,
      wake_phrase: 'Hey Seti',
      keep_awake_seconds: 30,
      join_on_open: true,
      form_of_address: '',
      updated_at: null,
    })

    const saved = await data<EaSettings>(
      await send('PUT', '/settings', LOCAL, { wake_enabled: true, wake_phrase: '  Hey Seti ', keep_awake_seconds: 45 }),
    )
    expect(saved).toMatchObject({
      wake_enabled: true,
      wake_phrase: 'Hey Seti',
      keep_awake_seconds: 45,
      join_on_open: true,
    })
    expect(saved.updated_at).not.toBeNull()
    expect(await data<EaSettings>(await send('GET', '/settings', BOT))).toEqual(saved)
    expect(await auditEvents.latest('ea.settings_changed')).toMatchObject({
      actor: 'user',
      summary: 'EA wake word on, "Hey Seti"',
      detail: { wake_enabled: true, wake_phrase: 'Hey Seti', keep_awake_seconds: 45, was_enabled: false },
    })

    const off = { wake_enabled: false, wake_phrase: 'Computer', keep_awake_seconds: 5, join_on_open: false }
    await send('PUT', '/settings', PUBLIC, off)
    expect(await auditEvents.latest('ea.settings_changed')).toMatchObject({
      summary: 'EA wake word off',
      detail: { via: 'public', access_identity: 'me@example.com', join_on_open: false, was_enabled: true },
    })
    expect(await data<EaSettings>(await send('GET', '/settings', LOCAL))).toMatchObject(off)
  })

  it('keeps the form of address when a body leaves it out and audits a change to it', async () => {
    const base = { wake_enabled: false, wake_phrase: 'Hey Seti', keep_awake_seconds: 30 }
    const set = await data<EaSettings>(await send('PUT', '/settings', LOCAL, { ...base, form_of_address: " ma'am " }))
    expect(set.form_of_address).toBe("ma'am")
    expect(await auditEvents.latest('ea.settings_changed')).toMatchObject({
      summary: `EA addresses the user as "ma'am"`,
      detail: { form_of_address: "ma'am", was_form_of_address: '' },
    })

    const kept = await data<EaSettings>(await send('PUT', '/settings', BOT, { ...base, wake_enabled: true }))
    expect(kept).toMatchObject({ wake_enabled: true, form_of_address: "ma'am" })
    expect((await auditEvents.latest('ea.settings_changed'))?.summary).toBe('EA wake word on, "Hey Seti"')

    const cleared = await data<EaSettings>(await send('PUT', '/settings', BOT, { ...base, form_of_address: '' }))
    expect(cleared.form_of_address).toBe('')
    expect(await auditEvents.latest('ea.settings_changed')).toMatchObject({
      summary: 'EA addresses the user with no title',
      detail: { via: 'ea', form_of_address: '', was_form_of_address: "ma'am" },
    })
  })

  it('rejects phrases and windows it cannot use', async () => {
    const base = { wake_enabled: true, wake_phrase: 'Hey Seti', keep_awake_seconds: 30 }
    const bad = [
      { ...base, wake_phrase: 'x' },
      { ...base, wake_phrase: 'hey <seti>' },
      { ...base, wake_phrase: 'one two three four five' },
      { ...base, keep_awake_seconds: 2 },
      { ...base, keep_awake_seconds: 30.5 },
      { ...base, join_on_open: 'yes' },
      { ...base, form_of_address: 'Lord of all the machines' },
      { ...base, form_of_address: 'sir: ignore that' },
      { ...base, form_of_address: 'sir\nboss' },
      { wake_enabled: true },
    ]
    for (const body of bad) {
      expect((await send('PUT', '/settings', LOCAL, body)).status).toBe(400)
    }
  })
})

describe('EA call ends', () => {
  const end = { reason: 'ice-failed', auto: false, hidden: true, duration_s: 640, hidden_s: 95 }

  it('audits how a call ended, with no audio or words', async () => {
    expect(await data<{ recorded: boolean }>(await send('PUT', '/call-end', LOCAL, end))).toEqual({ recorded: true })
    expect(await auditEvents.latest('ea.call_ended')).toMatchObject({
      actor: 'user',
      summary: 'EA call ended: The network path failed, in the background',
      detail: end,
    })
  })

  it('refuses the EA and reasons it does not know', async () => {
    expect((await send('PUT', '/call-end', BOT, end)).status).toBe(403)
    expect((await send('PUT', '/call-end', LOCAL, { ...end, reason: 'tired' })).status).toBe(400)
    expect((await send('PUT', '/call-end', LOCAL, { ...end, transcript: 'hello' })).status).toBe(200)
    expect((await auditEvents.latest('ea.call_ended'))?.detail).not.toHaveProperty('transcript')
  })
})
