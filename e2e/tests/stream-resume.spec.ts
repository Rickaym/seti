import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, MessagePage, Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { HOLD_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { startSessionAgent } from './support/restart.js'
import { seedLoadingTask } from './support/transcript-loading.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const update = (title: string) => ({
  source: 'pr',
  kind: 'ci_failed',
  subject: 'e2e/web#12',
  title,
  body: 'Failing checks on abc1234:\n- unit (failure)',
  url: 'https://github.com/e2e/web/pull/12',
})

const assistant = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    session_id: 'resume-session',
    uuid: randomUUID(),
  })

/** A task with one update the agent read and two still waiting, written straight to the database. */
async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, input_mode, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', 'queue', ?, ?)`,
    id,
    title,
    paths.checkout,
    at,
    at,
  )
  await db.message(id, 'input', JSON.stringify(update('Read update')), at)
  await db.message(id, 'prompt', JSON.stringify({ text: '', auto: true, inputs: 1 }), at)
  await db.message(id, 'input', JSON.stringify(update('First waiting update')), at)
  await db.message(id, 'input', JSON.stringify(update('Second waiting update')), at)
  await db.message(id, 'sdk', assistant(`Opening reply of ${title}`), at)
  await db.close()
  return id
}

/** Rows written without telling any stream, so only a resuming stream can bring them. */
async function addRows(id: string, texts: readonly string[]): Promise<void> {
  const db = openSeedDb()
  for (const text of texts) {
    await db.message(id, 'sdk', assistant(text), new Date().toISOString())
  }
  await db.close()
}

/** Dismisses the waiting updates through the server, which edits their rows in place. */
async function dismissUpdates(request: APIRequestContext, id: string): Promise<void> {
  const res = await request.post(`/api/tasks/${id}/inputs/dismiss`, { data: { up_to: Number.MAX_SAFE_INTEGER } })
  expect(res.ok()).toBe(true)
}

/** Every URL the page opened the task's stream with. */
function streamRequests(page: Page, id: string): string[] {
  const urls: string[] = []
  page.on('request', (request) => {
    if (request.url().includes(`/api/tasks/${id}/stream`)) {
      urls.push(request.url())
    }
  })
  return urls
}

const transcript = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Transcript' })

/** Each shown row's id with the state line of a queued prompt, which an edit changes in place. */
async function shownRows(page: Page): Promise<string[]> {
  return transcript(page)
    .locator('[data-message-id]')
    .evaluateAll((rows) =>
      rows.map((row) => {
        const text = row.textContent
        const state = /queued|not sent/.exec(text)?.[0] ?? ''
        return `${row.getAttribute('data-message-id') ?? ''} ${state}`
      }),
    )
}
const listItem = (page: Page, title: string) => page.getByRole('button', { name: new RegExp(title) })

/** The texts of the task's rows as the server holds them, oldest first. */
async function serverReplies(request: APIRequestContext, id: string): Promise<string[]> {
  const { data } = (await (await request.get(`/api/tasks/${id}/messages`)).json()) as Envelope<MessagePage>
  return data.messages.flatMap((row) => {
    if (row.kind !== 'sdk' || row.payload.type !== 'assistant') {
      return []
    }
    const [block] = row.payload.message.content
    return block?.type === 'text' ? [block.text] : []
  })
}

async function expectTranscriptMatches(page: Page, request: APIRequestContext, id: string): Promise<void> {
  const main = page.getByRole('main')
  for (const text of await serverReplies(request, id)) {
    await expect(transcript(page).getByText(text, { exact: true })).toHaveCount(1)
  }
  await expect(main.locator('[data-kind="input"]')).toHaveCount(3)
  await expect(main.locator('[data-dismissed]')).toHaveCount(2)
  await expect(main.getByTestId('queued-inputs')).toBeHidden()
}

test('coming back to an agent resumes its stream after the cached rows', async ({ page, request }) => {
  const first = unique('Resume first')
  const second = unique('Resume second')
  const id = await seedTask(first)
  const other = await seedLoadingTask(second)
  const urls = streamRequests(page, id)
  await page.goto('/#agents')
  await listItem(page, first).click()
  await expect(transcript(page).getByText(`Opening reply of ${first}`)).toBeVisible()
  await expect(page.getByRole('main').getByTestId('queued-inputs')).toHaveText(/^2 queued/)
  await listItem(page, second).click()
  await expect(transcript(page).getByText(other.reply)).toBeVisible()

  await addRows(id, ['Written while away 1', 'Written while away 2'])
  await dismissUpdates(request, id)
  await listItem(page, first).click()

  await expect(transcript(page).getByText('Written while away 2')).toBeVisible()
  await expectTranscriptMatches(page, request, id)
  expect(urls).toHaveLength(2)
  expect(urls[0]).not.toContain('after=')
  expect(urls[1]).toContain('after=')
})

test('a network drop mid-turn ends with the rows and status the server holds', async ({ page, context, request }) => {
  const { id } = await startSessionAgent(request)
  const urls = streamRequests(page, id)
  await page.goto(`/#agents/${id}`)
  const view = transcript(page)
  await expect(view).toContainText('Session ')
  expect((await request.post(`/api/tasks/${id}/messages`, { data: { prompt: HOLD_PROMPT } })).ok()).toBe(true)
  await expect(view).toContainText('Working on it.')
  const interrupt = page.getByRole('button', { name: 'Interrupt and send' })
  await expect(interrupt).toBeVisible()

  const before = await shownRows(page)
  await context.setOffline(true)
  expect((await request.post(`/api/tasks/${id}/stop`, { data: {} })).ok()).toBe(true)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('stopped')
  await context.setOffline(false)

  await expect(interrupt).toBeHidden()
  await expect.poll(async () => (await shownRows(page)).length).toBeGreaterThan(before.length)
  const shown = await shownRows(page)
  await page.reload()
  await expect(view).toContainText('Working on it.')
  await expect.poll(async () => shownRows(page)).toEqual(shown)
  expect(urls.length).toBeGreaterThan(1)
})
