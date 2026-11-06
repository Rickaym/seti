import {
  DEFAULT_TIERS,
  type EaAnsweredAsk,
  type EaAsk,
  type EaInboxDelivered,
  type EaLlmMessage,
  type EaUnseenReplies,
  type NotificationStatus,
} from '@seti/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { asAgent } from '../access.js'
import { createApp } from '../app.js'
import { sql } from '../db.js'
import { decideAsk } from '../ea-asks.js'
import { resetAttention } from '../ea-attention.js'
import { recordFocus, resetPresence } from '../presence.js'
import { auditEvents } from '../store/audit.js'
import { eaAsks } from '../store/ea-replies.js'
import { eaHistory } from '../store/ea.js'
import { eaInbox } from '../store/inbox.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'

const app = createApp()
const USER = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
const BOT = { ...USER, ...EA_AUTH }

async function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const chat = (role: 'user' | 'assistant', content: string) => ({
  kind: 'chat' as const,
  message: { role, content } as EaLlmMessage,
})
const toolCall = {
  kind: 'chat' as const,
  message: {
    role: 'assistant',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'delete_agent', arguments: '{}' } }],
  } as EaLlmMessage,
}

async function append(body: object) {
  return (await data<{ ids: number[] }>(await send('POST', '/ea/history/messages', BOT, body))).ids
}

const unseen = async () => data<EaUnseenReplies>(await send('GET', '/ea/replies', USER))

async function asked(summary = 'delete agent Voicemail retry', key = 'delete_agent:["t1"]', turn = 1) {
  const body = { tool: 'delete_agent', args: { task: 'Voicemail retry' }, summary, key, epoch: 'e1', turn }
  return data<EaAsk>(await send('POST', '/ea/asks', BOT, body))
}

const decide = async (id: number, decision: 'allow' | 'deny', headers = USER) =>
  send('POST', `/ea/asks/${String(id)}/decision`, headers, { decision })

const claim = async () => data<EaAnsweredAsk[]>(await send('POST', '/ea/asks/claim', BOT, {}))

beforeEach(async () => {
  await eaHistory.clear()
  await sql`DELETE FROM ea_ask`
  await sql`DELETE FROM ea_inbox`
})

describe('unseen EA replies', () => {
  it('marks only the last written reply of a notifying batch, and nothing without notify', async () => {
    await append({ entries: [chat('user', 'quiet'), chat('assistant', 'Not shown.')] })
    const ids = await append({
      entries: [chat('user', 'What runs?'), chat('assistant', 'Let me look.'), toolCall, chat('assistant', 'Two.')],
      notify: true,
    })
    const page = await unseen()
    expect(page.total).toBe(1)
    expect(page.replies).toEqual([{ id: ids[3], text: 'Two.', created_at: expect.any(String) as string, asks: [] }])
  })

  it('marks seen by id or through an id, for every tab alike', async () => {
    const [first] = await append({ entries: [chat('assistant', 'One.')], notify: true })
    const [second] = await append({ entries: [chat('assistant', 'Two.')], notify: true })
    const [third] = await append({ entries: [chat('assistant', 'Three.')], notify: true })
    expect(await data<{ seen: number }>(await send('POST', '/ea/replies/seen', USER, { ids: [second] }))).toEqual({
      seen: 1,
    })
    expect((await unseen()).replies.map((r) => r.id)).toEqual([first, third])
    await data(await send('POST', '/ea/replies/seen', USER, { through: third }))
    expect((await unseen()).total).toBe(0)
    expect((await send('POST', '/ea/replies/seen', USER, {})).status).toBe(400)
  })

  it('shows an inbox notice the EA posted without a report, and seeing it acknowledges the item', async () => {
    resetAttention()
    recordFocus({ device_id: 'focused-page', agents: [], active: true })
    const at = new Date(Date.now() - 1000).toISOString()
    const notice = { body: 'Finished its turn', url: null, task_id: null, due_at: at, created_at: at }
    const alert = await eaInbox.add({
      ...notice,
      kind: 'channel_event',
      event: 'event',
      title: 'Fix the login redirect',
      severity: 'info',
      source: 'Fix the login redirect',
    })
    const routine = await eaInbox.add({
      ...notice,
      kind: 'watch_event',
      event: 'turn_finished',
      title: 'Routine news',
      severity: 'success',
      source: 'Routine',
    })
    const body = { ids: [alert.id, routine.id], via: 'chat', notify: [alert.id, routine.id] }
    const delivered = await data<EaInboxDelivered>(await send('POST', '/ea/inbox/deliver', BOT, body))
    expect(delivered.items.map((item) => item.route)).toEqual(['toast', 'digest'])
    const page = await unseen()
    expect(page.replies.map((r) => r.text)).toEqual(['Fix the login redirect: Finished its turn'])
    expect((await eaInbox.unread(new Date().toISOString())).unread).toBe(2)
    await data(await send('POST', '/ea/replies/seen', USER, { ids: [page.replies[0]?.id] }))
    expect((await eaInbox.unread(new Date().toISOString())).unread).toBe(1)
    resetPresence()
  })
})

describe('questions the EA asks', () => {
  it('ties a question to its reply, takes one Allow, and hands the call to the EA once', async () => {
    const ask = await asked()
    expect(ask.state).toBe('pending')
    const ids = await append({
      entries: [chat('user', 'Delete it'), chat('assistant', 'That deletes it. Shall I go ahead?')],
      notify: true,
      asks: [ask.id],
    })
    const [reply] = (await unseen()).replies
    expect(reply?.id).toBe(ids[1])
    expect(reply?.asks.map((a) => [a.id, a.summary, a.state])).toEqual([
      [ask.id, 'delete agent Voicemail retry', 'pending'],
    ])

    expect((await data<EaAsk>(await decide(ask.id, 'allow'))).state).toBe('allowed')
    const again = await decide(ask.id, 'deny')
    expect(again.status).toBe(409)
    expect(await again.text()).toContain('already allowed')

    expect(await claim()).toEqual([
      { id: ask.id, tool: 'delete_agent', args: { task: 'Voicemail retry' }, summary: ask.summary, decision: 'allow' },
    ])
    expect(await claim()).toEqual([])
    const done = await data<EaAsk>(
      await send('POST', `/ea/asks/${String(ask.id)}/outcome`, BOT, { outcome: 'done', detail: 'Deleted' }),
    )
    expect(done.state).toBe('done')
    expect(await auditEvents.latest('ea.ask_allowed')).toMatchObject({
      actor: 'user',
      summary: 'Allowed the EA to delete agent Voicemail retry',
    })
  })

  it('hands a Deny to the EA without a call to run', async () => {
    const ask = await asked()
    expect((await data<EaAsk>(await decide(ask.id, 'deny'))).state).toBe('denied')
    expect((await claim()).map((a) => a.decision)).toEqual(['deny'])
    const outcome = await send('POST', `/ea/asks/${String(ask.id)}/outcome`, BOT, { outcome: 'done' })
    expect(outcome.status).toBe(409)
  })

  it('refuses an answer once the question expired, and one to a question never asked', async () => {
    const old = await eaAsks.add(
      {
        tool: 'delete_agent',
        args: {},
        summary: 'delete agent Old',
        key: 'delete_agent:["old"]',
        epoch: 'e1',
        turn: 1,
      },
      new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    )
    const res = await decide(old.id, 'allow')
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('expired')
    expect((await decide(old.id + 1000, 'allow')).status).toBe(404)
    expect(await claim()).toEqual([])
  })

  it("is the user's alone: the EA and agents cannot answer, and only the EA asks or claims", async () => {
    const ask = await asked()
    expect((await decide(ask.id, 'allow', BOT)).status).toBe(403)
    const agent = { id: 'agent-1', title: 'Helper', seti_control: 'full' as const }
    await expect(asAgent(agent, async () => decideAsk(ask.id, 'allow'))).rejects.toThrow(
      "Agents cannot answer the EA's questions",
    )
    const body = { tool: 'delete_agent', args: {}, summary: 'x', key: 'k', epoch: 'e1', turn: 1 }
    expect((await send('POST', '/ea/asks', USER, body)).status).toBe(403)
    expect((await send('POST', '/ea/asks/claim', USER, {})).status).toBe(403)
    expect((await eaAsks.get(ask.id, new Date().toISOString()))?.state).toBe('pending')
  })
})

describe("the user's yes in the chat or on a call", () => {
  const confirm = async (body: object) =>
    data<EaAnsweredAsk[]>(await send('POST', '/ea/asks/confirm', BOT, { epoch: 'e1', ...body }))

  it('asking the same change again while open reuses the first question and its turn', async () => {
    const first = await asked('delete agent Voicemail retry', 'k1', 1)
    const again = await asked('delete agent Voicemail retry', 'k1', 2)
    expect(again.id).toBe(first.id)
    expect((await confirm({ key: 'k1', turn: 2 })).map((a) => a.id)).toEqual([first.id])
  })

  it('takes only questions asked before the yes, in this EA process or an earlier one', async () => {
    const one = await asked('subscribe the agent', 'k1', 3)
    const two = await asked('create the reminder', 'k2', 3)
    expect(await confirm({ ids: [one.id, two.id], turn: 3 })).toEqual([])
    const restarted = await confirm({ ids: [one.id, two.id], epoch: 'e2', turn: 1 })
    expect(restarted.map((a) => [a.id, a.decision])).toEqual([
      [one.id, 'allow'],
      [two.id, 'allow'],
    ])
    expect(await confirm({ ids: [one.id], turn: 9 })).toEqual([])
    expect((await unseen()).total).toBe(0)
    expect((await decide(one.id, 'deny')).status).toBe(409)
  })

  it('is the EA bot alone that reports a yes it heard', async () => {
    const ask = await asked()
    const res = await send('POST', '/ea/asks/confirm', USER, { ids: [ask.id], epoch: 'e2', turn: 1 })
    expect(res.status).toBe(403)
  })
})

describe('the attention tiers', () => {
  it('default to push for urgent and active, the brief for digest, and change audited', async () => {
    const before = await data<NotificationStatus>(await send('GET', '/notifications', USER))
    expect(before.settings).toEqual(DEFAULT_TIERS)
    const after = await data<NotificationStatus>(await send('PUT', '/notifications/settings', BOT, { active: 'brief' }))
    expect(after.settings).toEqual({ ...DEFAULT_TIERS, active: 'brief' })
    const event = await auditEvents.latest('system.notifications_changed')
    expect(event?.summary).toContain('active brief')
    expect(event?.detail).toMatchObject({ via: 'ea', active: 'brief' })
    await send('PUT', '/notifications/settings', USER, DEFAULT_TIERS)
  })

  it('never let needs-you go quiet', async () => {
    expect((await send('PUT', '/notifications/settings', USER, { urgent: 'off' })).status).toBe(400)
    expect((await send('PUT', '/notifications/settings', USER, { urgent: 'brief' })).status).toBe(400)
  })
})
