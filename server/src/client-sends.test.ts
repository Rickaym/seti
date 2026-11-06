import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { Task, TeamPosted } from '@seti/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { sendOnce, sendKey } from './client-sends.js'
import { messages, sql, tasks } from './db.js'
import { endSession } from './runner.js'
import { auditEvents } from './store/audit.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-client-sends-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const state = { turns: [] as { task: string; text: string }[] }
  const fake = new FakeSdk(function* ({ text, session }) {
    state.turns.push({ task: session.options.env?.SETI_TASK_ID ?? '', text })
    yield fakeResult()
  })
  return { state, fake }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.fake.query,
}))

const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const created: string[] = []

async function newTask(): Promise<string> {
  const id = `send-task-${String(created.length + 1)}`
  created.push(id)
  await tasks.insert({ id, title: id, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  return id
}

const post = async (path: string, body: unknown) =>
  app.request(`/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) })

const promptsOf = async (id: string) =>
  (await messages.page(id, 100)).messages.filter((row) => row.kind === 'prompt').map((row) => row.payload)

const turnsOf = (id: string) => sdk.state.turns.filter((turn) => turn.task === id)

async function auditCount(kind: string, subject: string | null): Promise<number> {
  await auditEvents.settled()
  const [row] = await sql<{ count: number }[]>`SELECT COUNT(*) AS count FROM audit_event
    WHERE kind = ${kind} AND (${subject}::text IS NULL OR subject_id = ${subject})`
  return row?.count ?? 0
}

beforeEach(() => {
  sdk.state.turns.length = 0
})

afterEach(async () => {
  for (const id of created) {
    await waitIdle(id)
    await endSession(id)
  }
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('a repeated client_id on a task message', () => {
  it('stores one prompt, runs one turn and audits once', async () => {
    const id = await newTask()
    const body = { prompt: 'Ship it', client_id: randomUUID() }
    const first = await post(`/tasks/${id}/messages`, body)
    expect(first.status).toBe(200)
    await waitIdle(id)
    const again = await post(`/tasks/${id}/messages`, body)
    expect(again.status).toBe(200)
    expect(((await again.json()) as { data: Task }).data.id).toBe(id)
    await waitIdle(id)
    expect(await promptsOf(id)).toEqual([expect.objectContaining({ text: 'Ship it', client_id: body.client_id })])
    expect(turnsOf(id)).toHaveLength(1)
    expect(await auditCount('task.message_sent', id)).toBe(1)
  })

  it('takes effect once when both copies arrive together', async () => {
    const id = await newTask()
    const body = { prompt: 'Race me', client_id: randomUUID() }
    const results = await Promise.all([1, 2, 3].map(async () => post(`/tasks/${id}/messages`, body)))
    expect(results.map((res) => res.status)).toEqual([200, 200, 200])
    await waitIdle(id)
    expect(await promptsOf(id)).toHaveLength(1)
    expect(turnsOf(id)).toHaveLength(1)
    expect(await auditCount('task.message_sent', id)).toBe(1)
  })

  it('treats the same id on another task as a separate send', async () => {
    const [one, two] = [await newTask(), await newTask()]
    const clientId = randomUUID()
    expect((await post(`/tasks/${one}/messages`, { prompt: 'Hello', client_id: clientId })).status).toBe(200)
    expect((await post(`/tasks/${two}/messages`, { prompt: 'Hello', client_id: clientId })).status).toBe(200)
    await Promise.all([waitIdle(one), waitIdle(two)])
    expect(await promptsOf(one)).toHaveLength(1)
    expect(await promptsOf(two)).toHaveLength(1)
  })

  it('sends every copy without an id, as older clients do', async () => {
    const id = await newTask()
    await post(`/tasks/${id}/messages`, { prompt: 'Once' })
    await waitIdle(id)
    await post(`/tasks/${id}/messages`, { prompt: 'Once' })
    await waitIdle(id)
    const prompts = await promptsOf(id)
    expect(prompts).toHaveLength(2)
    expect(prompts.some((payload) => 'client_id' in payload)).toBe(false)
  })

  it('refuses an id that is not a uuid', async () => {
    const id = await newTask()
    expect((await post(`/tasks/${id}/messages`, { prompt: 'x', client_id: 'nope' })).status).toBe(400)
  })
})

describe('a repeated client_id on a group chat post', () => {
  it('posts once and answers the repeat with the first result', async () => {
    const before = await auditCount('team.message_posted', null)
    const body = { text: 'Status check, everyone', client_id: randomUUID() }
    const [first, second] = await Promise.all([post('/team/messages', body), post('/team/messages', body)])
    const [a, b] = [(await first.json()) as { data: TeamPosted }, (await second.json()) as { data: TeamPosted }]
    expect(a.data.message.id).toBe(b.data.message.id)
    const [row] = await sql<{ count: number }[]>`SELECT COUNT(*) AS count FROM team_message WHERE text = ${body.text}`
    expect(row?.count).toBe(1)
    expect(await auditCount('team.message_posted', null)).toBe(before + 1)
  })
})

describe('sendOnce', () => {
  it('runs a failed send again on retry', async () => {
    const key = sendKey('task_start', 'new', randomUUID())
    const codec = { save: (value: number) => value, load: (saved: number) => saved }
    let runs = 0
    const failing = async () => {
      runs += 1
      return Promise.reject(new Error('planner down'))
    }
    await expect(sendOnce(key, failing, codec)).rejects.toThrow('planner down')
    const working = async () => {
      runs += 1
      return Promise.resolve(runs)
    }
    expect(await sendOnce(key, working, codec)).toBe(2)
    expect(await sendOnce(key, working, codec)).toBe(2)
    expect(runs).toBe(2)
  })
})
