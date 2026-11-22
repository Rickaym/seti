import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { ArchivedTaskEntry, TaskListEntry } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  return id
}

async function box(locator: Locator): Promise<{ x: number; width: number; height: number }> {
  const found = await locator.boundingBox()
  if (found === null) {
    throw new Error('The element has no box')
  }
  return found
}

const main = (page: Page) => page.getByRole('main')
const row = (page: Page, id: string) => main(page).locator(`[data-task-id="${id}"]`)
const archiveOf = (page: Page, title: string) =>
  main(page).getByRole('button', { name: `Archive ${title}`, exact: true })

test('on a phone the list menu puts Archive on each row, one tap archives and Undo restores', async ({
  page,
  request,
}) => {
  const title = unique('Phone row archive')
  const id = await seedAgent(title)
  await page.goto('/#agents')
  await expect(row(page, id)).toBeVisible()
  await expect(archiveOf(page, title), 'rows stay plain until asked').toBeHidden()

  await main(page).getByRole('button', { name: 'More list actions' }).tap()
  const item = page.getByRole('menuitemcheckbox', { name: 'Archive agents' })
  await expectTouchTarget(item)
  await item.tap()
  const archive = archiveOf(page, title)
  await expect(archive).toBeVisible()
  await expectTouchTarget(archive, 'Archive', 'both')
  const [button, line, light] = [
    await box(archive),
    await box(row(page, id)),
    await box(row(page, id).locator('[data-status-light]')),
  ]
  expect(button.height, 'the row keeps its height').toBeLessThanOrEqual(line.height)
  expect(button.x + button.width, 'Archive sits beside the light').toBeLessThanOrEqual(light.x)
  await expect(row(page, id).getByText(title)).toBeVisible()
  await expectFitsPhone(page, 'agent list with Archive on its rows')

  await archive.tap()
  await expect(page.getByRole('dialog', { name: 'Archive agent' })).toHaveCount(0)
  const toast = toasts(page).filter({ hasText: `Archived "${title}"` })
  await expect(toast).toBeVisible()
  await expect(row(page, id)).toHaveCount(0)
  await expect(page).toHaveURL(/#agents$/)
  expect((await apiData<ArchivedTaskEntry[]>(request, '/tasks/archived')).map((task) => task.id)).toContain(id)

  await toast.getByRole('button', { name: 'Undo' }).tap()
  await expect(row(page, id)).toBeVisible()
  expect((await apiData<TaskListEntry[]>(request, '/tasks')).map((task) => task.id)).toContain(id)

  const done = main(page).getByRole('button', { name: 'Done', exact: true })
  await expectTouchTarget(done)
  await done.tap()
  await expect(archiveOf(page, title)).toBeHidden()
})
