import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { auditQuery, projectClaude } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { auditEvents } from '../store/audit.js'
import { threadFollows } from '../store/threads.js'
import { USER_AUTH } from '../test-auth.js'
import { followSentThreads, THREAD_CAP } from './follow.js'

const SEND = 'mcp__plugin_slack_slack__slack_send_message'

let count = 0
async function newTask(): Promise<string> {
  const id = `thread-task-${String(++count)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  return id
}

const ts = (n: number) => `17000${String(n).padStart(5, '0')}.000100`
const link = (channel: string, n: number) => `https://acme.slack.com/archives/${channel}/p${ts(n).replace('.', '')}`

/** The agent sends one Slack message and Seti ingests the call and its result. */
async function send(taskId: string, channel: string, n: number, threadTs?: string): Promise<void> {
  const id = `call-${taskId}-${channel}-${String(n)}`
  const input = {
    channel_id: channel,
    message: 'private words',
    ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
  }
  const use = {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name: SEND, input }] },
  }
  const result = {
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Sent ${link(channel, n)}` }] },
  }
  await followSentThreads(taskId, projectClaude(use as unknown as SDKMessage))
  await followSentThreads(taskId, projectClaude(result as unknown as SDKMessage))
}

const events = async (taskId: string) =>
  (await auditEvents.page(auditQuery.parse({ kind: 'task', limit: 200 }))).events.filter((e) => e.subject_id === taskId)

const kinds = async (taskId: string) => (await events(taskId)).map((e) => e.kind)

describe('followSentThreads', () => {
  it('follows the thread of each message the agent sends, once, and keeps no text', async () => {
    const task = await newTask()
    await send(task, 'C0PROJ1234', 1)
    await send(task, 'C0PROJ1234', 2, ts(1))
    const [thread] = await threadFollows.forTask(task)
    expect(thread).toMatchObject({
      service: 'slack',
      space: 'acme',
      channel: 'C0PROJ1234',
      thread: ts(1),
      since: ts(1),
    })
    expect(thread?.url).toBe(link('C0PROJ1234', 1))
    expect(await kinds(task)).toEqual(['task.thread_followed'])
    const audited = JSON.stringify(await events(task))
    expect(audited).not.toContain('private words')
  })

  it('lists the threads on the task route', async () => {
    const task = await newTask()
    await send(task, 'C0OTHER123', 3)
    const response = await createApp().request(`/api/tasks/${task}/threads`, {
      headers: { host: 'localhost', ...USER_AUTH },
    })
    expect(response.status).toBe(200)
    const listed = (await response.json()) as { data: { channel: string }[] }
    expect(listed.data.map((t) => t.channel)).toEqual(['C0OTHER123'])
  })

  it(`stops the least recently active thread past ${String(THREAD_CAP)}`, async () => {
    const task = await newTask()
    for (let n = 1; n <= THREAD_CAP + 1; n++) {
      await send(task, 'C0BUSY1234', n)
    }
    const threads = await threadFollows.forTask(task)
    expect(threads.filter((t) => t.stopped_at === null)).toHaveLength(THREAD_CAP)
    expect(threads.find((t) => t.stopped_at !== null)).toMatchObject({ thread: ts(1), stop_reason: 'cap' })
    expect((await kinds(task)).filter((k) => k === 'task.thread_stopped')).toHaveLength(1)
  })
})
