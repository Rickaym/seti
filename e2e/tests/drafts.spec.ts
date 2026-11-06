import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { SendMessageInput } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

/** An idle task written straight into the database, so no agent turn ever starts. */
async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  await db.message(id, 'prompt', JSON.stringify({ text: `First prompt of ${title}.` }), ts)
  await db.close()
  return id
}

const reply = (page: Page) => page.getByRole('combobox', { name: 'Reply' })
const listItem = (page: Page, id: string) => page.locator(`[data-task-id="${id}"]`)

async function openTask(page: Page, id: string, title: string): Promise<void> {
  await listItem(page, id).getByRole('button', { name: title }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: title })).toBeVisible()
}

test('keeps an unsent reply per task across views and reloads, and drops it once sent', async ({ page }) => {
  const first = await seedTask('E2E reply one')
  const second = await seedTask('E2E reply two')
  const sent: SendMessageInput[] = []
  await page.route(`**/api/tasks/${first}/messages`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    sent.push(route.request().postDataJSON() as SendMessageInput)
    await route.fulfill({ json: { data: {}, meta: {} } })
  })

  await page.goto(`/#agents/${first}`)
  await expect(page.getByText('First prompt of E2E reply one.')).toBeVisible()
  await reply(page).fill('Half-written follow-up')

  await openTask(page, second, 'E2E reply two')
  await expect(reply(page)).toHaveValue('')
  await openTask(page, first, 'E2E reply one')
  await expect(reply(page)).toHaveValue('Half-written follow-up')

  await reply(page).fill('Half-written follow-up, edited')
  await page.goto('/#context')
  await page.goto(`/#agents/${first}`)
  await expect(reply(page)).toHaveValue('Half-written follow-up, edited')

  await reply(page).fill('Typed right before a reload')
  await page.reload()
  await expect(reply(page)).toHaveValue('Typed right before a reload')

  await reply(page).press('Enter')
  await expect(reply(page)).toHaveValue('')
  await expect
    .poll(() => sent)
    .toEqual([{ prompt: 'Typed right before a reload', interrupt: false, client_id: expect.any(String) }])
  await expect(page.locator('[data-pending-send][data-state="sending"]')).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('First prompt of E2E reply one.')).toBeVisible()
  await expect(reply(page)).toHaveValue('')
})

test('keeps the start page draft through leaving it and clears it once the agent starts', async ({ page }) => {
  const message = page.getByLabel('Message')
  const open = async () => {
    await page.goto('/#agents')
    await page.getByRole('main').getByRole('button', { name: 'New agent' }).click()
    await expect(message).toBeVisible()
  }

  await open()
  await message.fill('Drafted message for the agent.')
  await page.goto('/#context')
  await page.reload()
  await open()
  await expect(message).toHaveValue('Drafted message for the agent.')

  await page.route('**/api/tasks/start', async (route) =>
    route.fulfill({ json: { data: { id: 'e2e-drafted' }, meta: {} } }),
  )
  await message.press('Enter')
  await expect(page).toHaveURL(/#agents\/e2e-drafted$/)
  await page.unroute('**/api/tasks/start')

  await open()
  await expect(message).toHaveValue('')
})
