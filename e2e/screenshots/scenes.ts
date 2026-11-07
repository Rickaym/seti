import type { Page } from '@playwright/test'
import { AGENTS } from './seed.js'
import { expect } from '../tests/support/fixtures.js'

const main = (page: Page) => page.getByRole('main')

async function openAgent(page: Page, id: string, title: string): Promise<void> {
  await page.goto(`/#agents/${id}`)
  await expect(main(page).getByRole('heading', { name: title }).first()).toBeVisible()
}

export async function home(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(main(page).getByRole('heading', { name: 'Home' })).toBeVisible()
  await expect(main(page).getByRole('complementary', { name: 'Metrics' }).getByText('Sweep flaky tests')).toBeVisible()
}

export async function phoneEa(page: Page): Promise<void> {
  await page.goto('/#ea')
  await expect(main(page).getByText('Tell the cart agent to take the second fix.')).toBeVisible()
  await expect(main(page).getByText(/rolled back: health check failed/)).toHaveCount(1)
}

export async function phoneList(page: Page): Promise<void> {
  await page.goto('/#agents')
  await expect(main(page).getByRole('region', { name: 'Needs you' })).toBeVisible()
}

export async function phonePermission(page: Page): Promise<void> {
  await openAgent(page, AGENTS.infra, 'Upgrade staging Postgres to 17')
  await expect(page.getByText('Allow Bash?')).toBeVisible()
}

export async function channels(page: Page): Promise<void> {
  await page.goto('/#settings/channels')
  await expect(main(page).getByText('Payments provider status').first()).toBeVisible()
  await main(page).getByRole('button', { name: 'Payments provider status activity' }).click()
  await expect(
    main(page)
      .getByText(/Card authorisation: degraded performance/)
      .first(),
  ).toBeVisible()
}
