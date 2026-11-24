import type { WebhookChannelInfo } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { sql } from '../db.js'
import { auditEvents } from '../store/audit.js'
import { taskInputs } from '../store/inputs.js'
import { threadFollows } from '../store/threads.js'
import { REPLY_SETTLE_MS, THREAD_RATE, expireThreads, routeDueReplies } from './route.js'
import { agentSends, api, data, deliver, message, quietTask, slackWebhook } from './slack-test-kit.js'

const ROOT = '1700000000.000100'
const ts = (n: number) => `17000001${String(n).padStart(2, '0')}.000100`
const reply = (n: number, fields: Record<string, unknown> = {}) =>
  message({ channel: 'C0PROJ1234', ts: ts(n), thread_ts: ROOT, ...fields })
let slackChannels = 0
/** A Slack channel id no other test's agent posted in. */
const freshChannel = () => `C0ROUTE${String(++slackChannels).padStart(3, '0')}`

/** Routes every reply as if the settle time had passed. */
const settle = async () => routeDueReplies(new Date(Date.now() + REPLY_SETTLE_MS + 1000).toISOString())

interface Replying {
  channel: WebhookChannelInfo
  task: string
  /** A reply in the agent's thread, in a Slack channel of its own. */
  replyIn: (n: number, fields?: Record<string, unknown>) => ReturnType<typeof message>
  slack: string
}

async function replying(name: string): Promise<Replying> {
  const channel = await slackWebhook(name)
  await data(await api('PUT', `/channels/${channel.id}/threads`, { replies: true }))
  const task = await quietTask()
  const slack = freshChannel()
  await agentSends(task, slack, ROOT)
  return { channel, task, slack, replyIn: (n, fields = {}) => reply(n, { channel: slack, ...fields }) }
}

const outcomes = async (task: string) =>
  (
    await sql<{ outcome: string | null; text: string }[]>`SELECT r.outcome, r.text FROM thread_reply r
      JOIN thread_follow f ON f.id = r.follow_id WHERE f.task_id = ${task} ORDER BY r.id`
  ).map((row) => `${row.outcome ?? 'waiting'}${row.text === '' ? '' : ' with text'}`)

describe('routing Slack thread replies', () => {
  it('waits the settle time, then hands the reply over as a thread update and keeps no text', async () => {
    const { channel, task, replyIn, slack } = await replying('Route')
    await deliver(channel, replyIn(1, { text: 'Can you also check staging?', user_profile: { display_name: 'Dana' } }))
    await routeDueReplies()
    expect(await outcomes(task)).toEqual(['waiting with text'])
    await settle()
    expect(await outcomes(task)).toEqual(['queued'])
    const [update] = await taskInputs.pending(task, 10)
    expect(update).toMatchObject({
      source: 'thread',
      kind: 'reply',
      subject: 'Dana',
      title: `Dana replied in Slack channel ${slack}, name not known`,
      body: 'Can you also check staging?',
      from: 'U0OTHER0001',
      thread: ROOT,
      message: ts(1),
      url: `https://acme.slack.com/archives/${slack}/p${ts(1).replace('.', '')}?thread_ts=${ROOT}&cid=${slack}`,
    })
    const [followed] = await threadFollows.forTask(task)
    expect(followed?.replies).toBe(1)
    const audited = (await auditEvents.page({ kind: 'task.thread_reply', limit: 20 })).events
    const mine = audited.find((event) => event.subject_id === task)
    expect(mine?.detail).toMatchObject({ bytes: 27, outcome: 'queued', author: 'U0OTHER0001' })
    expect(JSON.stringify(mine)).not.toContain('staging')
  })

  it('names the channel and the people a reply mentions once Seti has seen their names', async () => {
    const { channel, task, replyIn, slack } = await replying('Names')
    await deliver(channel, replyIn(5, { user: 'U0NAMES001', text: `<@U0SAM00001|Sam> look at <#${slack}|proj>` }))
    await deliver(channel, replyIn(6, { user: 'U0NAMES001', text: 'and <@U0SAM00001>' }))
    await settle()
    const titles = (await taskInputs.pending(task, 10)).map((input) => `${input.title}: ${input.body}`)
    expect(titles).toContain('U0NAMES001 replied in Slack #proj: @Sam look at #proj')
    expect(titles).toContain('U0NAMES001 replied in Slack #proj: and @Sam')
  })

  it("drops the agent's own message whose echo came before its result", async () => {
    const channel = await slackWebhook('Race')
    await data(await api('PUT', `/channels/${channel.id}/threads`, { replies: true }))
    const task = await quietTask()
    await agentSends(task, 'C0PROJ1234', ROOT)
    await deliver(channel, reply(2))
    await agentSends(task, 'C0PROJ1234', ts(2), ROOT)
    await settle()
    expect(await outcomes(task)).toEqual(['own'])
    expect(await taskInputs.pending(task, 10)).toEqual([])
  })

  it("holds a bot's reply for the user's next message", async () => {
    const { channel, task, replyIn } = await replying('Bot')
    await deliver(channel, replyIn(3, { user: undefined, bot_id: 'B0CIBOT001', bot_profile: { name: 'CI' } }))
    await settle()
    const [update] = await taskInputs.pending(task, 10)
    expect(update).toMatchObject({ source: 'thread', subject: 'CI', bot: true, delivery: 'with_message' })
  })

  it(`sends at most ${String(THREAD_RATE)} replies of one thread an hour`, async () => {
    const { channel, task, replyIn } = await replying('Rate')
    for (let n = 10; n < 11 + THREAD_RATE; n++) {
      await deliver(channel, replyIn(n))
    }
    await settle()
    const seen = await outcomes(task)
    expect(seen.filter((outcome) => outcome === 'queued')).toHaveLength(THREAD_RATE)
    expect(seen.filter((outcome) => outcome === 'rate')).toHaveLength(1)
  })

  it('gives an archived agent nothing and stops following', async () => {
    const { channel, task, replyIn } = await replying('Archived')
    await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE id = ${task}`
    await deliver(channel, replyIn(40))
    await settle()
    expect(await outcomes(task)).toEqual(['skipped'])
    expect((await threadFollows.forTask(task))[0]).toMatchObject({ stop_reason: 'archived' })
  })

  it('stops threads that went quiet for 7 days or were followed for 30', async () => {
    const [quiet, old] = [await quietTask(), await quietTask()]
    await agentSends(quiet, 'C0QUIET123', ROOT)
    await agentSends(old, 'C0AGED1234', ROOT)
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
    await sql`UPDATE thread_follow SET last_activity_at = ${days(8)} WHERE task_id = ${quiet}`
    await sql`UPDATE thread_follow SET created_at = ${days(31)} WHERE task_id = ${old}`
    await expireThreads()
    expect((await threadFollows.forTask(quiet))[0]).toMatchObject({ stop_reason: 'quiet' })
    expect((await threadFollows.forTask(old))[0]).toMatchObject({ stop_reason: 'age' })
  })
})
