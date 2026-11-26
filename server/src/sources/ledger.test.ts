import type { CodexMessage, SourceMatch } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { unarchiveTask } from '../archive.js'
import { sql, tasks } from '../db.js'
import { nodeLink } from '../node-link.js'
import { appendMessage } from '../session-ingest.js'
import { taskArchives } from '../store/archive.js'
import { sourceItems } from '../store/sources.js'
import { USER_AUTH } from '../test-auth.js'
import { quietTask } from '../threads/test-slack-kit.js'
import { matchSources } from './match.js'
import { claudeCall } from './test-ledger.js'
import { CHANNEL, channelDetailed, HOST, linearIssue, prViewText } from './test-sources.js'

const app = createApp()
beforeAll(() => {
  createApp()
})

const READ = 'mcp__plugin_slack_slack__slack_read_channel'
const TS = '1764000000.000100'
const LINK = `https://${HOST}/archives/${CHANNEL}/p1764000000000100`
const SEND_LINK = `https://${HOST}/archives/${CHANNEL}/p1764000900000100`
const TOKEN = ['gh', 'p_', 'A'.repeat(36)].join('')

let calls = 0

/** An agent that sent one Slack message, which tells Seti the workspace host, then read a channel. */
async function readerTask(lines: readonly string[] = ['the rollout starts on Monday at 09:00']): Promise<string> {
  const task = await quietTask()
  const sent = JSON.stringify({ message_link: SEND_LINK })
  await claudeCall(task, 'mcp__plugin_slack_slack__slack_send_message', { channel_id: CHANNEL, message: 'hi' }, sent)
  await claudeCall(task, READ, { channel_id: CHANNEL }, channelDetailed([{ ts: TS, lines: [...lines] }]))
  return task
}

async function match(task: string, refs: { href: string; quote: string | null }[]): Promise<SourceMatch[]> {
  const res = await app.request(`/api/tasks/${task}/sources`, {
    method: 'POST',
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ refs }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: SourceMatch[] }).data
}

describe('evidence ledger', () => {
  it('records a read with a permalink built from the host the agent saw, and a pointer, not a copy', async () => {
    const task = await readerTask()
    const [item] = await sourceItems.forTask(task)
    expect(item).toMatchObject({ kind: 'slack', container: CHANNEL, permalink: LINK, at: '2025-11-24T16:00:00.000Z' })
    const [row] = await sql<{ spans: string }[]>`SELECT spans FROM source_item WHERE task_id = ${task}`
    expect(row?.spans).not.toContain('rollout')
  })

  it('previews a cited item and verifies a quote from it, not a near miss', async () => {
    const task = await readerTask()
    const [hit, miss] = await match(task, [
      { href: LINK, quote: 'the rollout starts on Monday' },
      { href: LINK, quote: 'the rollout starts on Tuesday' },
    ])
    expect(hit).toEqual({
      href: LINK,
      source: { kind: 'slack', container: CHANNEL, place: '#release', at: '2025-11-24T16:00:00.000Z', permalink: LINK },
      verified: true,
      unread: false,
    })
    expect(miss).toMatchObject({ verified: false, unread: false })
  })

  it('says a Slack or GitHub permalink the agent never saw is not read, and nothing of other links', async () => {
    const task = await readerTask()
    const assembled = `https://${HOST}/archives/${CHANNEL}/p1764000555000100`
    const results = await match(task, [
      { href: assembled, quote: null },
      { href: SEND_LINK, quote: null },
      { href: 'https://github.com/acme/api/pull/77', quote: null },
      { href: 'https://example.com/plan', quote: null },
    ])
    expect(results.map((one) => [one.source, one.unread])).toEqual([
      [null, true],
      [null, false],
      [null, true],
      [null, false],
    ])
  })

  it("keeps each agent's ledger its own", async () => {
    const reader = await readerTask()
    const other = await quietTask()
    await appendMessage(other, { kind: 'prompt', payload: { text: 'summarise the release channel' } })
    expect(await sourceItems.forTask(reader)).toHaveLength(1)
    const [seen] = await match(other, [{ href: LINK, quote: 'the rollout starts on Monday' }])
    expect(seen).toMatchObject({ source: null, verified: false, unread: true })
  })

  it('reads the text as the transcript stores it, with credentials redacted', async () => {
    const task = await readerTask([`the key is ${TOKEN} for now`])
    const [kept] = await match(task, [{ href: LINK, quote: `the key is ${TOKEN} for now` }])
    expect(kept?.verified).toBe(false)
    const [stored] = await sql<{ payload: string }[]>`SELECT payload FROM task_message WHERE task_id = ${task}
      ORDER BY id DESC LIMIT 1`
    expect(stored?.payload).not.toContain(TOKEN)
  })

  it('goes with the transcript: archive drops it, restore reads it again, delete removes it', async () => {
    const task = await readerTask()
    expect(await taskArchives.archive(task, 'user')).not.toBeNull()
    expect(await sourceItems.forTask(task)).toEqual([])
    const [gone] = await matchSources(task, [
      { href: `https://${HOST}/archives/${CHANNEL}/p1764000555000100`, quote: null },
    ])
    expect(gone?.unread).toBe(false)
    await unarchiveTask(task)
    expect((await sourceItems.forTask(task)).map((item) => item.permalink)).toEqual([LINK])
    await tasks.remove(task)
    expect(await sourceItems.forTask(task)).toEqual([])
  })

  it('records a stored row only once its call ended well', async () => {
    const task = await quietTask()
    await appendMessage(task, { kind: 'seti', payload: { error: 'not a tool result' } })
    await claudeCall(task, READ, { channel_id: CHANNEL }, 'Error: channel_not_found')
    expect(await sourceItems.forTask(task)).toEqual([])
  })
})

describe('evidence ledger on Codex', () => {
  const ROOT = '01a20244-c954-7390-bda1-b0194900d399'
  const item = (type: string, method: string, fields: object) => ({
    root: ROOT,
    message: { method, params: { threadId: ROOT, item: { type, ...fields } } },
  })

  async function codexTask(): Promise<string> {
    const id = `codex-ledger-${String(++calls)}`
    const at = new Date().toISOString()
    await sql`INSERT INTO task (id, title, cwd, status, runtime, created_at, updated_at)
      VALUES (${id}, ${id}, '/tmp', 'idle', 'codex', ${at}, ${at})`
    return id
  }

  it('records a Linear MCP read and a gh view from the same neutral events', async () => {
    const task = await codexTask()
    const mcp = { id: 'call_linear', server: 'linear', tool: 'get_issue', arguments: { id: 'ENG-12' } }
    const done = {
      status: 'completed',
      result: { content: [{ type: 'text', text: linearIssue('ENG-12', 'ship it') }] },
    }
    const shell = { id: 'call_gh', command: "/bin/bash -lc 'gh pr view 12 -R acme/api'", cwd: '/tmp' }
    const messages = [
      item('mcpToolCall', 'item/started', { ...mcp, status: 'inProgress' }),
      item('mcpToolCall', 'item/completed', { ...mcp, ...done }),
      item('commandExecution', 'item/started', { ...shell, status: 'inProgress' }),
      item('commandExecution', 'item/completed', {
        ...shell,
        status: 'completed',
        aggregatedOutput: prViewText('acme/api', 12, 'the body'),
        exitCode: 0,
      }),
    ]
    for (const payload of messages as unknown as CodexMessage[]) {
      await nodeLink.journal(task, { type: 'message', runtime: 'codex', payload })
    }
    expect((await sourceItems.forTask(task)).map((one) => [one.kind, one.ref, one.permalink])).toEqual([
      ['linear', 'linear:ENG-12', 'https://linear.app/acme/issue/ENG-12/a-title'],
      ['github', 'github:acme/api#12', 'https://github.com/acme/api/pull/12'],
    ])
  })
})
