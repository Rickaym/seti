import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { CommandCatalog, Envelope, MessagePage, MessageRow, SendMessageInput } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const SESSION = 'interrupt-session'

const assistant = (text: string) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: randomUUID(),
})

const result = (isError: boolean) => ({
  type: 'result',
  subtype: isError ? 'error_during_execution' : 'success',
  is_error: isError,
  duration_ms: 3000,
  num_turns: 2,
  result: 'ok',
  errors: [],
  total_cost_usd: 0.01,
  session_id: SESSION,
  uuid: randomUUID(),
})

/** A task written straight into the database, so no agent turn ever starts. */
async function seedTask(status: 'idle' | 'running', rows: [string, unknown][]): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, session_id, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?)`,
    id,
    `Interrupt ${status}`,
    paths.checkout,
    SESSION,
    status,
    ts,
    ts,
  )
  for (const [kind, payload] of rows) {
    await db.message(id, kind, JSON.stringify(payload), ts)
  }
  await db.close()
  return id
}

async function openTask(page: Page, taskId: string, visible: string) {
  const catalog: CommandCatalog = {
    cwd: paths.checkout,
    probed_at: new Date().toISOString(),
    fresh: true,
    approximate: false,
    commands: [],
  }
  await page.route(/\/api\/tasks\/[^/]+\/commands$/, async (route) =>
    route.fulfill({ json: { data: catalog, meta: {} } satisfies Envelope<CommandCatalog> }),
  )
  await page.goto(`/#agents/${taskId}`)
  await expect(page.getByText(visible)).toBeVisible()
}

const composerStatus = (page: Page) => page.getByRole('status', { name: 'Composer status' })

test('the composer queues messages while the agent works and interrupts only when asked', async ({ page, request }) => {
  const taskId = await seedTask('running', [
    ['prompt', { text: 'Refactor the auth module.' }],
    ['sdk', assistant('Reading the auth module first.')],
  ])
  const sent: SendMessageInput[] = []
  await page.route(`**/api/tasks/${taskId}/messages`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    sent.push(route.request().postDataJSON() as SendMessageInput)
    await route.fulfill({ json: { data: {}, meta: {} } })
  })
  await openTask(page, taskId, 'Reading the auth module first.')
  const reply = page.getByRole('combobox', { name: 'Reply' })
  const interrupt = page.getByRole('button', { name: 'Interrupt and send' })
  await expect(reply).toBeEnabled()
  await expect(reply).toHaveAttribute(
    'placeholder',
    'Enter queues it for the agent, Alt+Enter interrupts and sends. Esc stops it.',
  )
  await expect(composerStatus(page)).toBeEmpty()
  await expect(interrupt).toHaveText('Interrupt')

  await reply.fill('/compact')
  await expect(composerStatus(page)).toContainText('Slash commands wait until the agent finishes its turn.')
  await expect(interrupt).toBeDisabled()
  await reply.fill('!git status')
  await expect(composerStatus(page)).toContainText('Shell commands wait until the agent finishes its turn.')
  await reply.press('Enter')
  await reply.press('Alt+Enter')
  expect(sent).toEqual([])

  await reply.fill('also check the tests')
  await expect(interrupt).toBeEnabled()
  await reply.press('Enter')
  await expect(reply).toHaveValue('')
  await reply.fill('stop and just say hi')
  await reply.press('Alt+Enter')
  await expect(reply).toHaveValue('')
  await reply.fill('forget all that')
  await interrupt.click()
  await expect(reply).toHaveValue('')
  await expect
    .poll(() => sent)
    .toEqual([
      { prompt: 'also check the tests', interrupt: false, client_id: expect.any(String) },
      { prompt: 'stop and just say hi', interrupt: true, client_id: expect.any(String) },
      { prompt: 'forget all that', interrupt: true, client_id: expect.any(String) },
    ])
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

test('the transcript badges a queued message until the agent reads it, and takes one back', async ({
  page,
  request,
}) => {
  const taskId = await seedTask('running', [
    ['prompt', { text: 'Refactor the auth module.' }],
    ['sdk', assistant('Reading the auth module first.')],
    ['prompt', { text: 'also check the tests', queued: 'waiting' }],
    ['prompt', { text: 'and the docs', queued: 'waiting' }],
    ['prompt', { text: 'never mind the lint', queued: 'removed' }],
  ])
  const listed = (await (await request.get(`/api/tasks/${taskId}/messages`)).json()) as { data: MessagePage }
  const rows = listed.data.messages
  const tests = rows.find((row) => row.kind === 'prompt' && row.payload.text === 'also check the tests')
  const docs = rows.find((row) => row.kind === 'prompt' && row.payload.text === 'and the docs')
  if (tests?.kind !== 'prompt' || docs === undefined) {
    throw new Error('seeded prompts are missing')
  }
  const picked: MessageRow = { ...tests, payload: { ...tests.payload, queued: 'delivered' } }
  let pickedUp = false
  await page.route(new RegExp(`/api/tasks/${taskId}/stream`), async (route) => {
    const body = pickedUp
      ? sse('updated', picked)
      : `retry: 300\n\n${sse('backlog', { messages: rows, has_older: false })}`
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body })
  })
  const removed: string[] = []
  await page.route(`**/api/tasks/${taskId}/queue/*`, async (route) => {
    removed.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    await route.fulfill({ json: { data: {}, meta: {} } })
  })
  await openTask(page, taskId, 'Reading the auth module first.')

  const entry = (text: string) => page.locator('[data-message-id]').filter({ hasText: text })
  await expect(entry('also check the tests')).toContainText('queued')
  await expect(entry('and the docs')).toContainText('queued')
  await expect(entry('never mind the lint')).toContainText('Taken back, not sent')
  await expect(entry('never mind the lint').getByRole('button', { name: 'Remove queued message' })).toHaveCount(0)

  await entry('and the docs').getByRole('button', { name: 'Remove queued message' }).click()
  await expect.poll(() => removed).toEqual([`DELETE /api/tasks/${taskId}/queue/${String(docs.id)}`])

  pickedUp = true
  await expect(entry('also check the tests')).not.toContainText('queued', { timeout: 5000 })
  await expect(entry('also check the tests').getByRole('button', { name: 'Remove queued message' })).toHaveCount(0)
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})

test('the transcript marks a turn that a new message interrupted', async ({ page, request }) => {
  const taskId = await seedTask('idle', [
    ['prompt', { text: 'Refactor the auth module.' }],
    ['sdk', assistant('Reading the auth module first.')],
    ['sdk', { ...assistant(''), type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } }],
    ['sdk', result(true)],
    ['prompt', { text: 'stop and just say hi', interrupted: true }],
    ['sdk', assistant('Hi!')],
    ['sdk', result(false)],
  ])
  await openTask(page, taskId, 'Hi!')
  await expect(page.getByText('agent stopped: interrupted by a new message')).toBeVisible()
  await expect(page.getByText(/^Turn interrupted \u00b7/)).toHaveCount(0)
  await expect(page.getByText(/^Turn done \u00b7/)).toBeVisible()
  await expect(page.getByText(/^Turn failed(:| \u00b7)/)).toHaveCount(0)
  await expect(page.getByText('[Request interrupted by user]')).toHaveCount(0)
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})
