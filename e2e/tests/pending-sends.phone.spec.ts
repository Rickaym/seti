import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.use({ allowedHttpStatuses: [409] })

async function seedTask(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Phone pending', paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded pending prompt.' }), at)
  await db.close()
  return id
}

const heightOf = async (page: Page, name: string) =>
  (await page.locator('[data-pending-send]').getByRole('button', { name }).boundingBox())?.height ?? 0

test('a message tapped out on a phone shows at once and a refused one offers Retry, Edit and Delete', async ({
  page,
}) => {
  const id = await seedTask()
  let refuse = true
  let held = 0
  await page.route(`**/api/tasks/${id}/messages`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    held += 1
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await (refuse
      ? route.fulfill({ status: 409, json: { error: { detail: 'Not now' } } })
      : route.fulfill({ json: { data: {}, meta: {} } }))
  })
  await page.goto(`/#agents/${id}`)
  await expect(page.getByText('Seeded pending prompt.')).toBeVisible()
  const reply = page.getByRole('combobox', { name: 'Reply' })

  await reply.fill('Sent from the train')
  await page.getByRole('button', { name: 'Send', exact: true }).tap()
  const row = page.locator('[data-pending-send]')
  await expect(row).toContainText('Sending...')
  await expect(reply).toHaveValue('')
  await expectFitsPhone(page, 'pending message')

  await expect(row).toHaveAttribute('data-state', 'failed')
  expect(await heightOf(page, 'Retry')).toBeGreaterThanOrEqual(44)
  expect(await heightOf(page, 'Edit')).toBeGreaterThanOrEqual(44)
  expect(await heightOf(page, 'Delete')).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'failed message')

  refuse = false
  await row.getByRole('button', { name: 'Retry' }).tap()
  await expect(row).toContainText('Sending...')
  await expect(row).toHaveAttribute('data-state', 'sent')
  expect(held).toBe(2)

  await reply.fill('Second try')
  refuse = true
  await page.getByRole('button', { name: 'Send', exact: true }).tap()
  const second = row.filter({ hasText: 'Second try' })
  await expect(second).toHaveAttribute('data-state', 'failed')
  await second.getByRole('button', { name: 'Edit' }).tap()
  await expect(second).toHaveCount(0)
  await expect(reply).toHaveValue('Second try')

  await reply.fill('Third try')
  await page.getByRole('button', { name: 'Send', exact: true }).tap()
  const third = row.filter({ hasText: 'Third try' })
  await expect(third).toHaveAttribute('data-state', 'failed')
  await third.getByRole('button', { name: 'Delete' }).tap()
  await expect(third).toHaveCount(0)
  await expect(reply).toHaveValue('')
})
