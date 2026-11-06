import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { MessagePage, MessageRow, TaskStatus } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const SESSION = 'compacting-session'
const BUSY_HINT = 'Enter queues it for the agent, Alt+Enter interrupts and sends. Esc stops it.'
const COMPACTING_HINT = 'Compacting the conversation. Messages you send now queue until it finishes. Esc stops it.'

const sdk = (payload: Record<string, unknown>) => ({ session_id: SESSION, uuid: randomUUID(), ...payload })

const assistant = (text: string) =>
  sdk({
    type: 'assistant',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
  })

const result = sdk({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 3000,
  num_turns: 2,
  result: 'ok',
  errors: [],
  total_cost_usd: 0.01,
})

const compacting = () => sdk({ type: 'system', subtype: 'status', status: 'compacting' })

const boundary = (trigger: 'manual' | 'auto', window?: number) =>
  sdk({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger, pre_tokens: 758_687, post_tokens: 16_169, duration_ms: 191_097 },
    ...(window === undefined ? {} : { seti_context_window: window }),
  })

type Seeded = [kind: string, payload: unknown, secondsAgo: number]

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

async function appendRows(taskId: string, rows: Seeded[]): Promise<void> {
  const db = openSeedDb()
  for (const [kind, payload, secondsAgo] of rows) {
    await db.message(taskId, kind, JSON.stringify(payload), ago(secondsAgo))
  }
  await db.close()
}

/** A running task written straight into the database, so no agent turn ever starts. */
async function seedTask(title: string, status: TaskStatus, rows: Seeded[]): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = ago(600)
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, session_id, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?)`,
    id,
    title,
    paths.checkout,
    SESSION,
    status,
    ts,
    ts,
  )
  await db.close()
  await appendRows(id, rows)
  return id
}

const indicator = (page: Page) => page.getByRole('status', { name: 'Compacting' })
const reply = (page: Page) => page.getByRole('combobox', { name: 'Reply' })
const composerStatus = (page: Page) => page.getByRole('status', { name: 'Composer status' })

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

test('a /compact turn shows one live compaction line, and the result after a reload', async ({ page, request }) => {
  const taskId = await seedTask('Compacting manually', 'running', [
    ['prompt', { text: 'Refactor the auth module.' }, 600],
    ['sdk', assistant('The auth module is refactored.'), 590],
    ['sdk', result, 589],
    ['prompt', { text: '/compact' }, 95],
    ['sdk', compacting(), 65],
    ['sdk', compacting(), 35],
    ['sdk', compacting(), 5],
  ])
  await page.goto(`/#agents/${taskId}`)
  await expect(page.getByText('The auth module is refactored.')).toBeVisible()

  await expect(indicator(page)).toHaveCount(1)
  await expect(indicator(page)).toContainText('Compacting the conversation')
  await expect(indicator(page)).toContainText(/1m 3\ds/)
  await expect(reply(page)).toHaveAttribute('placeholder', COMPACTING_HINT)
  await expect(composerStatus(page)).toBeEmpty()

  await appendRows(taskId, [
    ['sdk', sdk({ type: 'system', subtype: 'status', status: null, compact_result: 'success' }), 1],
    ['sdk', boundary('manual'), 1],
  ])
  await page.reload()
  await expect(page.getByText('Compacted \u00b7 758.7k \u2192 16.2k tokens \u00b7 3m 11s')).toBeVisible()
  await expect(indicator(page)).toHaveCount(0)
  await expect(reply(page)).toHaveAttribute('placeholder', BUSY_HINT)
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})

test('auto compaction shows live, then its boundary or the end of the turn clears it', async ({ page, request }) => {
  const taskId = await seedTask('Compacting automatically', 'running', [
    ['prompt', { text: 'Work through the failing tests.' }, 120],
    ['sdk', assistant('Working through the failing tests.'), 110],
    ['sdk', compacting(), 20],
  ])
  const listed = (await (await request.get(`/api/tasks/${taskId}/messages`)).json()) as { data: MessagePage }
  const rows = listed.data.messages
  const last = rows.at(-1)
  if (last === undefined) {
    throw new Error('seeded rows are missing')
  }
  const live = (offset: number, payload: unknown): MessageRow =>
    ({ ...last, id: last.id + offset, created_at: new Date().toISOString(), kind: 'sdk', payload }) as MessageRow
  let stage: 'compacting' | 'done' = 'compacting'
  await page.route(new RegExp(`/api/tasks/${taskId}/stream`), async (route) => {
    const events = {
      compacting: sse('backlog', { messages: rows, has_older: false }),
      done: sse('message', live(1, boundary('auto', 1_000_000))),
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `retry: 300\n\n${events[stage]}`,
    })
  })
  await page.goto(`/#agents/${taskId}`)
  await expect(page.getByText('Working through the failing tests.')).toBeVisible()
  await expect(indicator(page)).toContainText(/Compacting the conversation\s*2\ds/)
  await expect(reply(page)).toHaveAttribute('placeholder', COMPACTING_HINT)

  stage = 'done'
  await expect(page.getByText(/^Compacted automatically at 76% \u00b7 758\.7k \u2192/)).toBeVisible()
  await expect(indicator(page)).toHaveCount(0)
  await expect(reply(page)).toHaveAttribute('placeholder', BUSY_HINT)
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})

test('a turn that ends while compacting drops the compaction line', async ({ page, request }) => {
  const taskId = await seedTask('Compacting then stopped', 'running', [
    ['prompt', { text: '/compact' }, 30],
    ['sdk', compacting(), 5],
  ])
  const listed = (await (await request.get(`/api/tasks/${taskId}/messages`)).json()) as { data: MessagePage }
  let ended = false
  await page.route(new RegExp(`/api/tasks/${taskId}/stream`), async (route) => {
    const body = ended
      ? sse('status', { status: 'error' })
      : sse('backlog', { messages: listed.data.messages, has_older: false })
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `retry: 300\n\n${body}`,
    })
  })
  await page.goto(`/#agents/${taskId}`)
  await expect(indicator(page)).toBeVisible()

  ended = true
  await expect(indicator(page)).toHaveCount(0)
  await expect(reply(page)).not.toHaveAttribute('placeholder', /Compacting/)
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})

async function listedRows(request: APIRequestContext, taskId: string): Promise<MessageRow[]> {
  const listed = (await (await request.get(`/api/tasks/${taskId}/messages`)).json()) as { data: MessagePage }
  return listed.data.messages
}

const autoCompacting = async (title: string) =>
  seedTask(title, 'running', [
    ['prompt', { text: 'Work through the failing tests.' }, 120],
    ['sdk', assistant('Working through the failing tests.'), 110],
    ['sdk', compacting(), 20],
  ])

test('an agent opened again shows compaction only once its stream answers', async ({ page, request }) => {
  const taskId = await autoCompacting('Compacting while away')
  const rows = await listedRows(request, taskId)
  let answering = true
  await page.route(new RegExp(`/api/tasks/${taskId}/stream`), async (route) => {
    const backlog = answering ? sse('backlog', { messages: rows, has_older: false }) : ''
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `retry: 300\n\n${backlog}`,
    })
  })
  await page.goto(`/#agents/${taskId}`)
  await expect(indicator(page)).toBeVisible()

  answering = false
  await page.evaluate(() => {
    window.location.hash = '#settings'
  })
  await expect(page.getByText('Working through the failing tests.')).toHaveCount(0)
  await page.evaluate((id) => {
    window.location.hash = `#agents/${id}`
  }, taskId)
  await expect(page.getByText('Working through the failing tests.')).toBeVisible()
  await expect(indicator(page)).toHaveCount(0)

  answering = true
  await expect(indicator(page)).toBeVisible()
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})

test('compaction that hears nothing for five minutes refetches the agent once', async ({ page, request }) => {
  const taskId = await autoCompacting('Compacting in silence')
  const rows = await listedRows(request, taskId)
  let opened = 0
  await page.route(new RegExp(`/api/tasks/${taskId}/stream`), async (route) => {
    opened += 1
    const first = sse('backlog', { messages: rows, has_older: false }) + sse('status', { status: 'running' })
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `retry: 600000\n\n${opened === 1 ? first : ''}`,
    })
  })
  await page.clock.install()
  await page.goto(`/#agents/${taskId}`)
  await expect(indicator(page)).toBeVisible()

  await appendRows(taskId, [
    ['sdk', sdk({ type: 'system', subtype: 'status', status: null, compact_result: 'success' }), 2],
    ['sdk', boundary('auto'), 2],
    ['sdk', assistant('The failing tests pass now.'), 1],
    ['sdk', result, 1],
  ])
  const db = openSeedDb()
  await db.run(`UPDATE task SET status = 'idle' WHERE id = ?`, taskId)
  await db.close()
  await page.clock.runFor(4 * 60_000)
  await expect(indicator(page)).toBeVisible()

  await page.clock.runFor(60_000)
  await expect(page.getByText('The failing tests pass now.')).toBeVisible()
  await expect(indicator(page)).toHaveCount(0)
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})
