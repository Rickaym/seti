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

export async function grid(page: Page): Promise<void> {
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  await expect(page.locator('[data-grid-item]')).toHaveCount(4)
  await expect(page.getByText('Allow Bash?')).toBeVisible()
}

export async function pullRequest(page: Page): Promise<void> {
  await openAgent(page, AGENTS.checkout, 'Retry card captures on gateway timeouts')
  await expect(main(page).getByText('ci pass', { exact: false }).first()).toBeVisible()
}

export async function files(page: Page): Promise<void> {
  await openAgent(page, AGENTS.guide, 'Write the v2 migration guide')
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Files', exact: true })
  await panel.getByRole('button', { name: /migration-v2\.md/ }).click()
  await expect(panel.getByRole('heading', { name: 'Migrating to API v2' })).toBeVisible()
}

export async function phoneEa(page: Page): Promise<void> {
  await page.goto('/#ea')
  await expect(main(page).getByText('Tell the cart agent to take the second fix.')).toBeVisible()
  await expect(main(page).getByText(/rolled back: health check failed/)).toHaveCount(1)
}

export async function groupChat(page: Page): Promise<void> {
  await openAgent(page, AGENTS.orders, 'Paginate the orders endpoint')
  await page.getByTestId('team-chat-toggle').first().click()
  await expect(page.getByRole('complementary', { name: 'Group chat' })).toContainText('next_cursor')
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

export async function phoneChannels(page: Page): Promise<void> {
  await page.goto('/#settings/channels')
  await expect(main(page).getByText('Payments provider status').first()).toBeVisible()
  await main(page).getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Channel sources' })).toBeVisible()
}

export async function security(page: Page): Promise<void> {
  await page.goto('/#settings/sandbox')
  await expect(main(page).getByText('Long-lived token')).toBeVisible()
}

export async function mods(page: Page): Promise<void> {
  await page.goto('/#settings/mods')
  await expect(
    main(page).getByRole('region', { name: 'Mods' }).getByRole('listitem', { name: 'Weather' }),
  ).toBeVisible()
}
