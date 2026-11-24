import type { ChannelSecret, ChannelEvent } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { sql } from '../db.js'
import { asciiJson } from '../golden/json.js'
import { channelStore } from '../store/channels.js'
import { agentSends, api, data, deliver, message, quietTask } from './slack-test-kit.js'

const OWNER = { authorizations: [{ user_id: 'U0OWNER001', is_bot: false }] }
const ROOT = '1700000000.000100'

/** Slack deliveries as a webhook with user events gets them, one of each kind Seti treats apart. */
const RECORDED: Record<string, object> = {
  'app mention': {
    ...OWNER,
    event: {
      type: 'app_mention',
      user: 'U0OTHER0001',
      text: '<@U0OWNER001> look',
      ts: '1700000001.000100',
      channel: 'C0PROJ1234',
    },
  },
  'plain message': { ...OWNER, ...message({ channel: 'C0PROJ1234', ts: '1700000002.000100' }) },
  'mention as a message': {
    ...OWNER,
    ...message({ channel: 'C0PROJ1234', ts: '1700000003.000100', text: 'hey <@U0OWNER001>' }),
  },
  'reply in a followed thread': {
    ...OWNER,
    ...message({ channel: 'C0PROJ1234', ts: '1700000004.000100', thread_ts: ROOT }),
  },
  edit: { ...OWNER, ...message({ channel: 'C0PROJ1234', ts: '1700000005.000100', subtype: 'message_changed' }) },
  'bot message': {
    ...OWNER,
    ...message({
      channel: 'C0PROJ1234',
      ts: '1700000006.000100',
      user: undefined,
      bot_id: 'B0CIBOT001',
      subtype: 'bot_message',
    }),
  },
  'direct message': { ...OWNER, ...message({ channel: 'D0DIRECT01', channel_type: 'im', ts: '1700000007.000100' }) },
}

const eventOf = (event: ChannelEvent | undefined) =>
  event === undefined
    ? null
    : {
        source: event.source,
        severity: event.severity,
        kind: event.kind,
        title: event.title,
        detail: event.detail,
        url: event.url,
        subject: event.subject,
        state: event.state,
      }

describe('a Slack webhook with both thread switches off', () => {
  it('handles every delivery as Seti did before thread replies', async () => {
    const task = await quietTask()
    await agentSends(task, 'C0PROJ1234', ROOT)
    await agentSends(task, 'D0DIRECT01', '1700000000.000200')
    const created = await api('POST', '/channels', {
      name: 'Slack mentions',
      preset: 'slack',
      secret: ['fake', 'slack', 'signing', 'secret'].join('-'),
      subscribe_ea: true,
    })
    const { channel } = await data<ChannelSecret>(created)
    const answers: Record<string, unknown> = {}
    for (const [name, payload] of Object.entries(RECORDED)) {
      answers[name] = await deliver(channel, payload)
    }
    const events = new Map((await channelStore.recent(channel.id, 50)).map((event) => [event.id, event]))
    const deliveries = (await channelStore.deliveries(channel.id, 50)).reverse().map((d) => ({
      status: d.status,
      http_status: d.http_status,
      reason: d.reason,
      excerpt: d.excerpt,
      filter: d.filter,
      routes: d.routes.map(({ target, label, outcome, reason }) => ({ target, label, outcome, reason })),
      event: eventOf(d.event_id === null ? undefined : events.get(d.event_id)),
    }))
    await expect(asciiJson({ answers, deliveries })).toMatchFileSnapshot('./switches-off.golden.json')
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM thread_reply r
      JOIN thread_follow f ON f.id = r.follow_id WHERE f.task_id = ${task}`
    expect(row?.n).toBe(0)
    const [seen] = await sql<
      { at: string | null }[]
    >`SELECT message_seen_at AS at FROM channel WHERE id = ${channel.id}`
    expect(seen?.at).toBeNull()
  })
})
