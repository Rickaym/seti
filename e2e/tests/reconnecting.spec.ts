import type { Page } from '@playwright/test'
import { expect, test, toasts } from './support/fixtures.js'
import { DROPPED_REQUEST, loseLink, runClockUntil, seedListedAgent } from './support/lost-link.js'

test.use({ allowedConsoleErrors: [DROPPED_REQUEST], allowedHttpStatuses: [500, 502] })

const bar = (page: Page) => page.getByRole('contentinfo')
const api = (page: Page, state: string) => bar(page).getByRole('status', { name: `API ${state}` })

test('a lost link shows one quiet Reconnecting item, keeps the list, raises no toast and clears itself', async ({
  page,
}) => {
  const title = await seedListedAgent()
  await page.clock.install()
  await page.goto('/#agents')
  const agent = page.getByText(title).first()
  await expect(agent).toBeVisible()
  await expect(api(page, 'up')).toBeVisible()

  const restore = await loseLink(page)
  await page.clock.runFor(5000)
  const item = api(page, 'reconnecting')
  await expect(item).toBeVisible()
  await expect(item).toHaveText('Reconnecting')
  await expect(item).toHaveAttribute('data-tone', 'muted')

  // Six more rounds of every 5 s poll, each of which once raised a toast of its own.
  for (let round = 0; round < 6; round += 1) {
    await page.clock.runFor(5000)
  }
  await expect(item).toBeVisible()
  await expect(bar(page).getByText('Reconnecting')).toHaveCount(1)
  await expect(toasts(page)).toHaveCount(0)
  await expect(agent).toBeVisible()
  await item.hover()
  await expect(page.getByRole('tooltip')).toContainText('The Seti server is not answering.')
  await expect(page.getByRole('tooltip')).toContainText('Every view keeps what it last showed')

  await restore()
  await runClockUntil(page, async () => expect(api(page, 'up')).toBeVisible({ timeout: 1000 }))
  await expect(bar(page).getByText('Reconnecting')).toHaveCount(0)
  await expect(toasts(page)).toHaveCount(0)
  await expect(agent).toBeVisible()
})

test('polls the server never answers time out into the same Reconnecting item', async ({ page }) => {
  const title = await seedListedAgent()
  await page.goto('/#agents')
  await expect(page.getByText(title).first()).toBeVisible()
  await expect(api(page, 'up')).toBeVisible()

  let hang = true
  const held: (() => void)[] = []
  await page.route('**/api/**', async (route) => {
    if (hang) {
      await new Promise<void>((resolve) => held.push(resolve))
    }
    await route.fallback()
  })
  // A poll goes out within 5 s and gives up 10 s later.
  await expect(api(page, 'reconnecting')).toBeVisible({ timeout: 25_000 })
  await expect(toasts(page)).toHaveCount(0)
  await expect(page.getByText(title).first()).toBeVisible()

  hang = false
  for (const release of held) {
    release()
  }
  await expect(api(page, 'up')).toBeVisible({ timeout: 15_000 })
  await expect(toasts(page)).toHaveCount(0)
})

test('an error the server answers with raises one toast that goes once the list loads again', async ({ page }) => {
  const title = await seedListedAgent()
  await page.clock.install()
  await page.goto('/#agents')
  await expect(page.getByText(title).first()).toBeVisible()

  await page.route('**/api/tasks', async (route) =>
    route.fulfill({ status: 500, json: { error: { detail: 'The database is restarting' } } }),
  )
  const failed = toasts(page).filter({ hasText: 'The agent list is not updating' })
  for (let round = 0; round < 4; round += 1) {
    await page.clock.runFor(5000)
  }
  await expect(failed).toHaveCount(1)
  await expect(failed).toContainText('The database is restarting')
  await expect(toasts(page)).toHaveCount(1)
  await expect(api(page, 'up')).toBeVisible()
  await expect(page.getByText(title).first()).toBeVisible()

  await page.unroute('**/api/tasks')
  await page.clock.runFor(5000)
  await expect(toasts(page)).toHaveCount(0)
})

test('a proxy answering 502 while Seti restarts reads as Reconnecting, with no toast', async ({ page }) => {
  const title = await seedListedAgent()
  await page.clock.install()
  await page.goto('/#agents')
  await expect(page.getByText(title).first()).toBeVisible()
  await expect(api(page, 'up')).toBeVisible()

  await page.route('**/api/**', async (route) => route.fulfill({ status: 502, body: 'Bad Gateway' }))
  for (let round = 0; round < 4; round += 1) {
    await page.clock.runFor(5000)
  }
  await expect(api(page, 'reconnecting')).toBeVisible()
  await expect(toasts(page)).toHaveCount(0)
  await expect(page.getByText(title).first()).toBeVisible()

  await page.unroute('**/api/**')
  await page.clock.runFor(5000)
  await expect(api(page, 'up')).toBeVisible()
  await expect(toasts(page)).toHaveCount(0)
})
