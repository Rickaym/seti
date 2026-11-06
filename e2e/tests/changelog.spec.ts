import type { Page } from '@playwright/test'
import type { Changelog } from '@seti/shared'
import { seeChangelogBefore } from './support/changelog-news.js'
import { apiData, expect, test } from './support/fixtures.js'
import { modToggle } from './support/mods.js'

const NEWS = 'New in Seti since you last looked'

const whatsNew = (page: Page) => page.getByRole('main')
const entry = (page: Page, text: string) => whatsNew(page).getByRole('listitem').filter({ hasText: text })
const settingsButton = (page: Page) =>
  page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Settings' })

const navItem = (page: Page) =>
  page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'About' })

test('About lists features and fixes by day, with upkeep behind All', async ({ page, request }) => {
  const commit = (await apiData<Changelog>(request, '/mods/whats-new/changelog')).version?.commit ?? 'none'
  await page.goto('/#settings/about')
  const body = whatsNew(page)
  const version = body.getByRole('link', { name: commit.slice(0, 7) })
  await expect(version).toHaveAttribute('href', `https://github.com/Rickaym/seti/commit/${commit}`)

  const days = body.getByRole('region')
  await expect(days).toHaveCount(7)
  await expect(days.first()).toHaveAccessibleName(/Oct 9/)
  await expect(entry(page, 'retry a turn once').getByRole('link', { name: '#10' })).toHaveAttribute(
    'href',
    'https://github.com/Rickaym/seti/pull/10',
  )
  await expect(entry(page, 'bump zod')).toHaveCount(0)
  await expect(entry(page, 'start page')).toHaveCount(0)

  await body.getByRole('button', { name: 'Upkeep' }).click()
  await expect(entry(page, 'bump zod')).toBeVisible()
  await expect(entry(page, 'explain the readme')).toBeVisible()

  await body.getByRole('button', { name: 'Older' }).click()
  await expect(entry(page, 'start page')).toBeVisible()
  await expect(entry(page, 'seed')).toBeVisible()
  await expect(body.getByRole('button', { name: 'Older' })).toHaveCount(0)

  const breaking = entry(page, 'keep tools within the limit')
  await expect(breaking).toContainText('Breaking')
  const toggle = breaking.getByRole('button', { expanded: false })
  await toggle.click()
  await expect(breaking.getByRole('button', { expanded: true })).toBeVisible()
  await expect(breaking.locator('strong')).toHaveText('quiet')
  await expect(entry(page, 'grid view').getByRole('button')).toHaveCount(0)
})

test('About says an update waits on main and how to install it', async ({ page }) => {
  await page.goto('/#settings/about')
  const update = whatsNew(page).locator('[data-update="available"]')
  await expect(update).toContainText('Update available: 2 new commits on main, 1 feature or fix')
  await expect(update.getByRole('link', { name: 'Compare' })).toHaveAttribute(
    'href',
    /^https:\/\/github\.com\/Rickaym\/seti\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/,
  )
  await expect(update.getByLabel('Update command', { exact: true })).toContainText('git checkout --detach origin/main')
})

test('new features put a dot on Settings and its About page until that is opened', async ({ page, request }) => {
  await seeChangelogBefore(request)
  await page.goto('/#agents')
  const button = settingsButton(page)
  await expect(button).toHaveAccessibleDescription(NEWS)
  await expect(button.locator('[data-news]')).toBeVisible()
  await button.click()
  await expect(navItem(page)).toHaveAccessibleDescription(NEWS)
  await navItem(page).click()
  await expect(page).toHaveURL(/#settings\/about$/)

  const marked = whatsNew(page)
    .locator('li[data-commit]')
    .filter({ has: page.locator('[data-news]') })
  await expect(marked).toHaveCount(3)
  await expect(marked.first()).toContainText('retry a turn once')
  await expect(button.locator('[data-news]')).toHaveCount(0)
  await expect(button).not.toHaveAccessibleDescription(NEWS)
  await expect(navItem(page).locator('[data-news]')).toHaveCount(0)

  await page.reload()
  await expect(whatsNew(page).locator('li[data-commit]').first()).toBeVisible()
  await expect(whatsNew(page).locator('li[data-commit] [data-news]')).toHaveCount(0)
})

test("the About settings page shows the version, the update and what's new", async ({ page, request }) => {
  const commit = (await apiData<Changelog>(request, '/mods/whats-new/changelog')).version?.commit ?? 'none'
  await page.goto('/#settings/about')
  const about = page.locator('[data-slot="detail-pane"]')
  await expect(about.getByRole('heading', { name: 'About', level: 2 })).toBeVisible()
  await expect(about.getByRole('link', { name: commit.slice(0, 7) })).toBeVisible()
  await expect(about.locator('[data-update="available"]')).toContainText('2 new commits on main')
  await expect(whatsNew(page).getByRole('region').first()).toBeVisible()
})

test("What's new is part of Seti, so About and its dot stay with no switch to turn them off", async ({
  page,
  request,
}) => {
  await seeChangelogBefore(request)
  await page.goto('/#settings/mods')
  const row = page.getByRole('region', { name: 'Mods' }).getByRole('listitem', { name: "What's new" })
  await expect(row.getByText('Core', { exact: true })).toBeVisible()
  await expect(row.getByRole('img', { name: 'Always on' })).toBeVisible()
  await expect(modToggle(page, "What's new")).toHaveCount(0)
  await expect(navItem(page)).toHaveAccessibleDescription(NEWS)
  const refused = await request.patch('/api/mods/whats-new', { data: { enabled: false } })
  expect(refused.status()).toBe(409)
  expect(await refused.text()).toContain("The What's new mod is part of Seti and always on")
  await page.reload()
  await expect(settingsButton(page).locator('[data-news]')).toBeVisible()
  await navItem(page).click()
  await expect(whatsNew(page).locator('[data-update="available"]')).toContainText('2 new commits on main')
})
