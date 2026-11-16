import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { ArchivedTaskEntry, TaskListEntry } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { HOLD_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { startSessionAgent } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  return id
}

const main = (page: Page) => page.getByRole('main')
const row = (page: Page, id: string) => main(page).locator(`[data-task-id="${id}"]`)
const archiveOf = (page: Page, title: string) =>
  main(page).getByRole('button', { name: `Archive ${title}`, exact: true })
const light = (page: Page, id: string) => row(page, id).locator('[data-status-light]')
const activeIds = async (request: APIRequestContext) =>
  (await apiData<TaskListEntry[]>(request, '/tasks')).map((task) => task.id)
const archivedIds = async (request: APIRequestContext) =>
  (await apiData<ArchivedTaskEntry[]>(request, '/tasks/archived')).map((task) => task.id)

test('a row shows Archive on hover, archives the open agent in one click and Undo restores it', async ({
  page,
  request,
}) => {
  const title = unique('E2E row archive')
  const id = await seedAgent(title)
  await page.goto(`/#agents/${id}`)
  await expect(main(page).getByRole('heading', { name: title })).toBeVisible()
  const archive = archiveOf(page, title)
  await expect(archive).toHaveCSS('opacity', '0')
  const [before, height] = [await light(page, id).boundingBox(), (await row(page, id).boundingBox())?.height]

  await row(page, id).hover()
  await expect(archive).toHaveCSS('opacity', '1')
  expect(await light(page, id).boundingBox(), 'the status light stays where it was').toEqual(before)
  expect((await row(page, id).boundingBox())?.height).toBe(height)
  const [button, status] = [await archive.boundingBox(), await light(page, id).boundingBox()]
  expect((button?.x ?? 0) + (button?.width ?? 0), 'Archive sits beside the light').toBeLessThanOrEqual(status?.x ?? 0)
  await archive.hover()
  await expect(page.getByRole('tooltip')).toContainText('Archive: leaves the list until you restore it')

  await archive.click()
  await expect(page.getByRole('dialog', { name: 'Archive agent' })).toHaveCount(0)
  const toast = toasts(page).filter({ hasText: `Archived "${title}"` })
  await expect(toast).toBeVisible()
  await expect(row(page, id)).toHaveCount(0)
  await expect(main(page).getByRole('status', { name: 'Archived agent' })).toContainText('Read-only until restored')
  expect(await archivedIds(request)).toContain(id)

  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(toasts(page).filter({ hasText: `Restored "${title}"` })).toBeVisible()
  await expect(row(page, id)).toBeVisible()
  await expect(main(page).getByRole('combobox', { name: 'Reply' })).toBeVisible()
  expect(await activeIds(request)).toContain(id)
  expect(await archivedIds(request)).not.toContain(id)
})

test('Archive on a row is reachable from the keyboard', async ({ page, request }) => {
  const title = unique('E2E row keys')
  const id = await seedAgent(title)
  const other = await seedAgent(unique('E2E row stays'))
  await page.goto(`/#agents/${other}`)
  const archive = archiveOf(page, title)
  const open = row(page, id).getByRole('button')
  await open.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(open).not.toBeFocused()
  await expect(async () => {
    await page.keyboard.press('Tab')
    await expect(open).toBeFocused({ timeout: 500 })
  }).toPass()
  await expect(archive).toHaveCSS('opacity', '1')
  await page.keyboard.press('Tab')
  await expect(archive).toBeFocused()
  await expect(archive).toHaveCSS('opacity', '1')
  await page.keyboard.press('Enter')
  await expect(toasts(page).filter({ hasText: `Archived "${title}"` })).toBeVisible()
  await expect(row(page, id)).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`#agents/${other}$`))
  expect(await archivedIds(request)).toContain(id)
})

test('a working agent shows Archive disabled with the reason, and it does nothing', async ({ page, request }) => {
  const { id } = await startSessionAgent(request)
  const { title } = await apiData<TaskListEntry>(request, `/tasks/${id}`)
  expect((await request.post(`/api/tasks/${id}/messages`, { data: { prompt: HOLD_PROMPT } })).ok()).toBe(true)
  await page.goto('/#agents')
  await expect(row(page, id).getByRole('img', { name: 'running' })).toBeVisible()
  await row(page, id).hover()
  const archive = archiveOf(page, title)
  await expect(archive).toHaveAttribute('aria-disabled', 'true')
  await archive.hover()
  await expect(page.getByRole('tooltip')).toContainText('Stop the agent to archive it')
  await archive.click({ force: true })
  await expect(row(page, id)).toBeVisible()
  await expect(toasts(page)).toHaveCount(0)
  expect(await activeIds(request)).toContain(id)

  expect((await request.post(`/api/tasks/${id}/stop`, { data: {} })).ok()).toBe(true)
  await expect(archive).toHaveAttribute('aria-disabled', 'false')
})

test('Archive agents in the list menu keeps Archive on every row until Done', async ({ page }) => {
  const titles = [unique('E2E tidy one'), unique('E2E tidy two')]
  const ids = [await seedAgent(titles[0] ?? ''), await seedAgent(titles[1] ?? '')]
  await page.goto('/#agents')
  await expect(row(page, ids[0] ?? '')).toBeVisible()
  await page.mouse.move(0, 0)
  for (const title of titles) {
    await expect(archiveOf(page, title)).toHaveCSS('opacity', '0')
  }
  await main(page).getByRole('button', { name: 'More list actions' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Archive agents' }).click()
  await page.mouse.move(0, 0)
  for (const title of titles) {
    await expect(archiveOf(page, title)).toHaveCSS('opacity', '1')
  }
  await archiveOf(page, titles[0] ?? '').click()
  await expect(row(page, ids[0] ?? '')).toHaveCount(0)
  await expect(archiveOf(page, titles[1] ?? '')).toHaveCSS('opacity', '1')

  await main(page).getByRole('button', { name: 'Done', exact: true }).click()
  await page.mouse.move(0, 0)
  await expect(archiveOf(page, titles[1] ?? '')).toHaveCSS('opacity', '0')
})
