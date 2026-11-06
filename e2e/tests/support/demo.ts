import type { Page } from '@playwright/test'
import { expect } from './fixtures.js'

/** A worker of the public demo, with `test.use`, for a visitor who brings no token. */
export const DEMO_WORKER = { serverEnv: { SETI_DEMO: '1' }, extraHTTPHeaders: {} }

/** The agent stuck on the terraform apply the demo asks about at start. */
export const INFRA_AGENT = 'Upgrade staging Postgres to 17'

export const CART_AGENT = 'Fix the flaky cart test'

/** Opens the demo's door and walks in, as a visitor following the README link does. */
export async function enterDemo(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Seti demo' })).toBeVisible()
  await expect(page.getByRole('note', { name: 'Demo' })).toContainText('Nothing here is real')
  await page.getByRole('button', { name: 'Enter demo' }).click()
  await expect(page.getByRole('note', { name: 'Demo' })).toBeVisible()
}
