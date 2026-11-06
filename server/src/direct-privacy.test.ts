import fs from 'node:fs'
import { chatSearchQuery, transcriptWindowQuery, type MessageRow, type Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { DIRECT_HIDDEN, hideDirect } from './direct-privacy.js'
import { liveContext } from './ea-context.js'
import { taskDocs } from './ea-index-docs.js'
import { readTranscript } from './history.js'
import { appendMessage, endSession } from './runner.js'
import { prepareAsk } from './side-chat/ask.js'
import { messageSearch } from './store/search.js'
import { taskDigest, transcriptPage } from './task-actions.js'
import { ensureMember, postTeamMessage } from './team.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'
import { openWorkspace } from './workspace/engine.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-direct-privacy-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  return new FakeSdk(function* () {
    yield fakeResult()
  })
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const HEADERS = { host: 'localhost', 'content-type': 'application/json' }
const SECRET = 'the staging key is in vault slot nine'
const ids = { sender: 'privacy-sender', recipient: 'privacy-recipient', third: 'privacy-third' }

async function make(id: string, title: string): Promise<Task> {
  await tasks.insert({ id, title, repo_id: null, cwd: scratch, worktree: false, pr_urls: [], seti_control: 'full' })
  await ensureMember({ id, title })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error(`${id} was not stored`)
  }
  return task
}

const sender = await make(ids.sender, 'Privacy sender')
const recipient = await make(ids.recipient, 'Privacy recipient')
const third = await make(ids.third, 'Privacy third')
const to = (await ensureMember(recipient)).handle

await postTeamMessage({ kind: 'task', taskId: sender.id }, SECRET, { to })
await waitIdle(recipient.id)
const posted = JSON.stringify({ message: { text: SECRET, to_kind: 'task', to_task_id: recipient.id } }, null, 1)
await appendMessage(sender.id, {
  kind: 'sdk',
  payload: {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_dm', name: 'mcp__seti__post_team_chat', input: { to, text: SECRET } }],
    },
  },
} as never)
await appendMessage(sender.id, {
  kind: 'sdk',
  payload: {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_dm', content: posted }] },
  },
} as never)

afterAll(async () => {
  for (const id of Object.values(ids)) {
    await endSession(id)
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

const asThird = async <T>(work: () => Promise<T>) => asAgent(third, work)
const asSender = async <T>(work: () => Promise<T>) => asAgent(sender, work)
const shows = (rows: readonly MessageRow[]) => JSON.stringify(rows).includes(SECRET)
const get = async (path: string, auth: Record<string, string> = EA_AUTH) =>
  app.request(`/api${path}`, { headers: { ...HEADERS, ...auth } })

describe('a direct message in a transcript', () => {
  it('shows to the user and its parties, and to anyone else as a placeholder', async () => {
    const page = async () => (await transcriptPage(recipient.id, 100)).messages
    expect(shows(await page())).toBe(true)
    expect(shows(await asSender(page))).toBe(true)
    const hidden = await asThird(page)
    expect(shows(hidden)).toBe(false)
    expect(JSON.stringify(hidden)).toContain(DIRECT_HIDDEN)
    const tools = async () => (await transcriptPage(sender.id, 100)).messages
    expect(shows(await asThird(tools))).toBe(false)
    expect(shows(await asAgent(recipient, tools))).toBe(true)
    expect(JSON.stringify(await asThird(tools))).toContain(DIRECT_HIDDEN)
  })

  it('is hidden from the EA in every page, single message and digest of the route', async () => {
    for (const path of [
      `/tasks/${recipient.id}/messages`,
      `/tasks/${recipient.id}/messages?after=0`,
      `/tasks/${sender.id}/messages`,
    ]) {
      const text = await (await get(path)).text()
      expect(text, path).not.toContain(SECRET)
      expect(await (await get(path, USER_AUTH)).text(), path).toContain(SECRET)
    }
    const digest = `/tasks/${recipient.id}/digest`
    expect(await (await get(digest)).text()).toContain(DIRECT_HIDDEN)
    expect(await (await get(digest, USER_AUTH)).text()).toContain('sent you a direct message')
    const input = (await messages.page(recipient.id, 100)).messages.find((row) => row.kind === 'input')
    const one = await (await get(`/tasks/${recipient.id}/messages/${String(input?.id)}`)).text()
    expect(one).toContain(DIRECT_HIDDEN)
    expect((await get(`/tasks/${recipient.id}/stream`)).status).toBe(403)
  })

  it('shows the EA the direct messages it is party to', async () => {
    await postTeamMessage({ kind: 'ea' }, 'Only for you and me', { to })
    await waitIdle(recipient.id)
    const text = await (await get(`/tasks/${recipient.id}/messages`)).text()
    expect(text).toContain('Only for you and me')
    expect(text).not.toContain(SECRET)
  })

  it('stays out of digests and history windows a third agent reads', async () => {
    const digest = await asThird(async () => taskDigest(recipient.id, 50))
    expect(JSON.stringify(digest)).toContain(DIRECT_HIDDEN)
    const told = JSON.stringify(await asSender(async () => taskDigest(recipient.id, 50)))
    expect(told).toContain('sent you a direct message')
    expect(JSON.stringify(digest)).not.toContain('sent you a direct message')
    const query = transcriptWindowQuery.parse({ include_tools: 'true' })
    const window = JSON.stringify(await asThird(async () => readTranscript(recipient, query)))
    expect(window).toContain(DIRECT_HIDDEN)
    expect(window).not.toContain('sent you a direct message')
    expect(JSON.stringify(await readTranscript(recipient, query))).toContain('sent you a direct message')
    expect(JSON.stringify(await asThird(async () => readTranscript(sender, query)))).not.toContain(SECRET)
  })

  it('never matches a third party search, and matches for its parties', async () => {
    const search = chatSearchQuery.parse({ q: 'vault slot nine', mode: 'text', tools: 'true' })
    expect((await asThird(async () => messageSearch.search(recipient.id, search))).hits).toEqual([])
    expect((await asThird(async () => messageSearch.search(sender.id, search))).hits).toEqual([])
    expect((await asSender(async () => messageSearch.search(recipient.id, search))).hits).toHaveLength(1)
    expect((await messageSearch.search(sender.id, search)).hits.length).toBeGreaterThan(0)
    const res = await get(`/tasks/${recipient.id}/search?q=vault%20slot%20nine`)
    expect(((await res.json()) as { data: { hits: unknown[] } }).data.hits).toEqual([])
  })

  it('stays out of the shared live context and the EA search index', async () => {
    expect((await liveContext()).text).not.toContain(SECRET)
    const rows = (await messages.page(recipient.id, 100)).messages
    const docs = taskDocs({ id: recipient.id, title: recipient.title, repo_slug: null }, rows, new Map())
    expect(JSON.stringify(docs)).not.toContain(SECRET)
  })

  it('refuses a third party a side question to an agent that holds one, and the EA its chat.md', async () => {
    await expect(
      asThird(async () => prepareAsk(recipient.id, { question: 'What is the key?' }, false)),
    ).rejects.toThrow('direct messages you are not part of')
    await openWorkspace(recipient.id)
    const file = await get(`/tasks/${recipient.id}/files/text?root=workspace&path=chat.md`)
    expect(file.status).toBe(403)
    expect(await file.text()).toContain('holds its direct messages')
    expect((await get(`/tasks/${recipient.id}/files/text?root=workspace&path=chat.md`, USER_AUTH)).status).toBe(200)
  })

  it('hides chat reads and chat.md appends that carry one in a third party copy', async () => {
    const rows: MessageRow[] = [
      {
        id: 1,
        task_id: sender.id,
        outward: [],
        created_at: new Date().toISOString(),
        kind: 'sdk',
        payload: {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'read', content: `[{"text": "x", "direct": true}]` }],
          },
        },
      } as never,
      {
        id: 2,
        task_id: sender.id,
        outward: [],
        created_at: new Date().toISOString(),
        kind: 'sdk',
        payload: {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'edit',
                name: 'Edit',
                input: { file_path: '/w/chat.md', new_string: `direct @${to}\n${SECRET}` },
              },
            ],
          },
        },
      } as never,
    ]
    const seen = await hideDirect(sender.id, rows, { kind: 'task', taskId: third.id })
    expect(shows(seen)).toBe(false)
    expect(JSON.stringify(seen)).not.toContain('"direct": true')
    expect(shows(await hideDirect(sender.id, rows, { kind: 'task', taskId: recipient.id }))).toBe(true)
  })
})
