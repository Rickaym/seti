import type { WebhookChannelInfo } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { asAgent } from '../access.js'
import { sql } from '../db.js'
import { auditEvents } from '../store/audit.js'
import { channelStore } from '../store/channels.js'
import { slackNames } from '../store/slack-names.js'
import { EA_AUTH } from '../test-auth.js'
import { setWebhookThreads } from './actions.js'
import { DM_WINDOW_MS } from './intake.js'
import { agentSends, api, data, deliver, message, quietTask, slackWebhook } from './slack-test-kit.js'

const ROOT = '1700000000.000100'
const reply = (ts: string, fields: Record<string, unknown> = {}) =>
  message({ channel: 'C0PROJ1234', ts, thread_ts: ROOT, ...fields })
const MULTI = 'C0MULTI123'

const queued = async (task: string) =>
  sql<{ message: string; text: string }[]>`SELECT r.message, r.text FROM thread_reply r
    JOIN thread_follow f ON f.id = r.follow_id WHERE f.task_id = ${task} ORDER BY r.id`

const switches = async (channel: WebhookChannelInfo, change: object) =>
  data<WebhookChannelInfo>(await api('PUT', `/channels/${channel.id}/threads`, change))

describe('Slack message events at the webhook', () => {
  it('keep plain messages from subscribers unless the filter keeps them, and note that they arrive', async () => {
    const channel = await slackWebhook('Slack mentions')
    expect(channel.threads).toEqual({ replies: false, dms: false, message_seen_at: null })
    const ignored = await deliver(channel, message({ channel: 'C0PROJ1234', ts: '1700000001.000100' }))
    expect(ignored.status).toBe('ignored')
    expect(ignored.reason).toContain('in no followed thread')
    const mention = await deliver(channel, { event: { type: 'app_mention', text: 'hi', ts: '1700000002.000100' } })
    expect(mention.status).toBe('accepted')
    expect((await channelStore.recent(channel.id, 5)).map((event) => event.kind)).toEqual(['app_mention'])
    const seen = (await data<WebhookChannelInfo[]>(await api('GET', '/channels'))).find((c) => c.id === channel.id)
    expect(seen?.threads?.message_seen_at).not.toBeNull()

    await data(
      await api('PUT', `/channels/${channel.id}/filter`, { script: 'export default () => true', enabled: true }),
    )
    expect((await deliver(channel, message({ channel: 'C0PROJ1234', ts: '1700000003.000100' }))).status).toBe(
      'accepted',
    )
  })

  it('show names Seti knows in place of ids in what subscribers get', async () => {
    const channel = await slackWebhook('Mentions with names')
    await slackNames.learn([{ id: 'U0RICKY001', kind: 'user', name: 'Ricky' }], 'test', new Date().toISOString())
    const text = '<@U0RICKY001> can you look at <#C0DEPLOY77|deploys> and C0DEPLOY77?'
    await deliver(channel, { event: { type: 'app_mention', text, ts: '1700000004.000100' } })
    const [event] = await channelStore.recent(channel.id, 1)
    expect(event?.title).toBe('@Ricky can you look at #deploys and #deploys?')
  })

  it('queue nothing for agents while both switches are off', async () => {
    const channel = await slackWebhook('Off')
    const task = await quietTask()
    await agentSends(task, 'C0PROJ1234', ROOT)
    await deliver(channel, reply('1700000010.000100'))
    expect(await queued(task)).toEqual([])
  })

  it('take the switches from the user only, and audit them', async () => {
    const channel = await slackWebhook('Switches')
    const refused = await api('PUT', `/channels/${channel.id}/threads`, { replies: true }, EA_AUTH)
    expect(refused.status).toBe(403)
    const agent = { id: await quietTask(), title: 'Full agent', seti_control: 'full' as const }
    await expect(asAgent(agent, async () => setWebhookThreads(channel.id, { replies: true }))).rejects.toThrow(
      /Agents cannot/,
    )
    expect((await channelStore.get(channel.id))?.thread_replies).toBe(false)
    expect((await switches(channel, { replies: true })).threads).toMatchObject({ replies: true, dms: true })
    expect((await switches(channel, { dms: false })).threads).toMatchObject({ replies: true, dms: false })
    expect((await switches(channel, { replies: false, dms: false })).threads).toMatchObject({ replies: false })
    expect((await switches(channel, { replies: true, dms: false })).threads).toMatchObject({ dms: false })
    const [event] = (await auditEvents.page({ kind: 'system.channel_threads_changed', limit: 1 })).events
    expect(event?.summary).toBe('Turned thread replies on and DM replies off on the webhook Switches')
    const generic = await data<{ channel: WebhookChannelInfo }>(
      await api('POST', '/channels', { name: 'Plain', preset: 'generic', subscribe_ea: false }),
    )
    expect(generic.channel.threads).toBeNull()
    expect((await api('PUT', `/channels/${generic.channel.id}/threads`, { replies: true })).status).toBe(400)
  })

  it('queue a reply for each agent that posted earlier in the thread, once, with secrets redacted', async () => {
    const channel = await slackWebhook('Replies')
    await switches(channel, { replies: true })
    const [first, second, bystander] = [await quietTask(), await quietTask(), await quietTask()]
    await agentSends(first, MULTI, ROOT)
    await agentSends(bystander, MULTI, '1700000010.000100')
    await deliver(channel, reply('1700000020.000100', { channel: MULTI }))
    await agentSends(second, MULTI, '1700000030.000100', ROOT)
    const later = reply('1700000040.000100', { channel: MULTI, text: `token ghp_${'z'.repeat(36)} works` })
    expect((await deliver(channel, later)).reason).toContain('queued for 2 followed thread(s)')
    await deliver(channel, later)
    expect((await queued(first)).map((row) => row.message)).toEqual(['1700000020.000100', '1700000040.000100'])
    const [mine] = await queued(second)
    expect(mine?.message).toBe('1700000040.000100')
    expect(mine?.text).not.toContain('z'.repeat(36))
    expect(await queued(bystander)).toEqual([])
  })

  it('never queue a message a Seti agent sent, nor edits and other threads', async () => {
    const channel = await slackWebhook('Own')
    await switches(channel, { replies: true })
    const task = await quietTask()
    await agentSends(task, 'C0PROJ1234', ROOT)
    await deliver(channel, message({ channel: 'C0PROJ1234', ts: ROOT }))
    await deliver(channel, reply('1700000050.000100', { subtype: 'message_changed' }))
    await deliver(channel, reply('1700000051.000100', { thread_ts: '1700000999.000100' }))
    await deliver(channel, message({ channel: 'C0PROJ1234', ts: '1700000052.000100' }))
    expect(await queued(task)).toEqual([])
  })

  it('take an unthreaded direct message for the agent that wrote there last, within the window, with DMs on', async () => {
    const channel = await slackWebhook('Direct')
    await switches(channel, { replies: true, dms: false })
    const [earlier, latest] = [await quietTask(), await quietTask()]
    await agentSends(earlier, 'D0DIRECT01', '1700000060.000100')
    await agentSends(latest, 'D0DIRECT01', '1700000061.000100')
    const dm = (ts: string) => message({ channel: 'D0DIRECT01', channel_type: 'im', ts })
    await deliver(channel, dm('1700000062.000100'))
    expect(await queued(latest)).toEqual([])
    await switches(channel, { dms: true })
    await deliver(channel, dm('1700000063.000100'))
    expect((await queued(latest)).map((row) => row.message)).toEqual(['1700000063.000100'])
    expect(await queued(earlier)).toEqual([])
    const stale = new Date(Date.now() - DM_WINDOW_MS - 60_000).toISOString()
    await sql`UPDATE thread_follow SET last_sent_at = ${stale} WHERE task_id = ${latest}`
    await deliver(channel, dm('1700000064.000100'))
    expect(await queued(latest)).toHaveLength(1)
  })
})
