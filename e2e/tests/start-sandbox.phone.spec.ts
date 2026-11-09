import type { Task } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const TARGET_PX = 40

test('a phone turns the sandbox off for one start with a touch-sized switch', async ({ page, request }) => {
  await page.goto('/#agents')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'New agent' }).tap()
  const sandbox = main.getByRole('button', { name: 'Sandbox', exact: true })
  await expect(sandbox).toHaveAttribute('aria-pressed', 'true')
  const box = await sandbox.boundingBox()
  expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(TARGET_PX)
  await sandbox.tap()
  await expect(sandbox).toHaveAttribute('aria-pressed', 'false')
  await expect(main.getByText('Starts outside the sandbox')).toBeVisible()
  await expectFitsPhone(page, 'start page with the sandbox off')
  await main.getByLabel('Message').fill('planner down: check the vpn from the host')
  await main.getByRole('button', { name: 'Start agent' }).tap()
  await expect(page).toHaveURL(/#agents\/[\da-f-]{36}$/)
  const id = new URL(page.url()).hash.split('/')[1] ?? ''
  expect((await apiData<Task>(request, `/tasks/${id}`)).sandbox).toBe(false)
  await page.goto('/#agents')
  expect((await page.request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
