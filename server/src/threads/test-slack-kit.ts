import { createHmac } from 'node:crypto'
import { projectClaude, type ChannelSecret, type ClaudeMessage, type WebhookChannelInfo } from '@seti/shared'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { USER_AUTH } from '../test-auth.js'
import { followSentThreads } from './follow.js'

const app = createApp()
const BASE = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', 'content-type': 'application/json' }
const SECRET = ['fake', 'slack', 'signing', 'secret'].join('-')
const SEND = 'mcp__plugin_slack_slack__slack_send_message'

/** A request to Seti's API; the response as it came. */
export const api = async (method: string, url: string, body?: unknown, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api${url}`, {
    method,
    headers: { ...BASE, ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** The `data` of a 200 answer. */
export async function data<T>(res: Response): Promise<T> {
  if (res.status !== 200) {
    throw new Error(`HTTP ${String(res.status)}: ${await res.text()}`)
  }
  return ((await res.json()) as { data: T }).data
}

/** A Slack webhook with the test signing secret. */
export async function slackWebhook(name: string): Promise<WebhookChannelInfo> {
  return (await data<ChannelSecret>(await api('POST', '/channels', { name, preset: 'slack', secret: SECRET }))).channel
}

let deliveries = 0

/** A signed Events API delivery to the webhook; the HTTP answer's JSON. */
export async function deliver(
  channel: WebhookChannelInfo,
  payload: object,
): Promise<{ status: string; reason: string }> {
  const body = JSON.stringify({ type: 'event_callback', event_id: `Ev${String(++deliveries)}`, ...payload })
  const at = String(Math.floor(Date.now() / 1000))
  const signed = `v0:${at}:${body}`
  const signature = `v0=${createHmac('sha256', SECRET).update(signed).digest('hex')}`
  const res = await app.request(channel.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': at, 'x-slack-signature': signature },
    body,
  })
  return data<{ status: string; reason: string }>(res)
}

/** A Slack `message` event, as user events deliver it. */
export const message = (fields: Record<string, unknown>) => ({
  event: { type: 'message', channel_type: 'channel', user: 'U0OTHER0001', text: 'Looks good', ...fields },
})

let count = 0

/** A task that holds its updates, so delivering one never starts a turn. */
export async function quietTask(): Promise<string> {
  const id = `slack-thread-${String(++count)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.setInputMode(id, 'queue')
  return id
}

/** The agent sends one Slack message with the Slack MCP server, and Seti ingests it. */
export async function agentSends(taskId: string, channel: string, ts: string, threadTs?: string): Promise<void> {
  const id = `call-${taskId}-${ts}`
  const input = { channel_id: channel, message: 'hi', ...(threadTs === undefined ? {} : { thread_ts: threadTs }) }
  const link = `https://acme.slack.com/archives/${channel}/p${ts.replace('.', '')}`
  const use = {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name: SEND, input }] },
  }
  const result = {
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Sent ${link}` }] },
  }
  await followSentThreads(taskId, projectClaude(use as unknown as ClaudeMessage))
  await followSentThreads(taskId, projectClaude(result as unknown as ClaudeMessage))
}
