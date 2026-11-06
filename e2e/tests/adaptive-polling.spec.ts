import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'

test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED/] })

const bar = (page: Page) => page.getByRole('contentinfo')

const isTasksPoll = (url: string) => new URL(url).pathname === '/api/tasks'

test('offline shows a quiet API state, sends no polls, and catches up once back online', async ({ page, context }) => {
  const polls: number[] = []
  page.on('request', (request) => {
    if (isTasksPoll(request.url())) {
      polls.push(Date.now())
    }
  })
  await page.clock.install()
  await page.goto('/#agents')
  await expect(bar(page).getByRole('status', { name: 'API up' })).toBeVisible()
  const online = polls.length
  await page.clock.runFor(5000)
  await expect.poll(() => polls.length).toBeGreaterThan(online)

  await context.setOffline(true)
  const offline = bar(page).getByRole('status', { name: 'API offline' })
  await expect(offline).toBeVisible()
  await expect(offline).toHaveAttribute('data-tone', 'muted')
  const before = polls.length
  // Longer than the 5 s interval of /tasks, so a poll that ignored offline would show.
  await page.clock.runFor(7000)
  expect(polls).toHaveLength(before)

  await offline.hover()
  await expect(page.getByRole('tooltip')).toContainText('This browser is offline.')

  const caughtUp = page.waitForRequest((request) => isTasksPoll(request.url()), { timeout: 2000 })
  await context.setOffline(false)
  await caughtUp
  await expect(bar(page).getByRole('status', { name: 'API up' })).toBeVisible()
})

test('repeated /tasks polls answer 304 while nothing changed', async ({ page }) => {
  let unchanged = 0
  let tagsSent = 0
  page.on('request', (request) => {
    if (isTasksPoll(request.url()) && request.headers()['if-none-match'] !== undefined) {
      tagsSent += 1
    }
  })
  page.on('response', (response) => {
    if (isTasksPoll(response.url()) && response.status() === 304) {
      unchanged += 1
    }
  })
  await page.goto('/#agents')
  await expect(bar(page).getByRole('status', { name: 'API up' })).toBeVisible()
  await expect.poll(() => unchanged, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  expect(tagsSent).toBeGreaterThanOrEqual(unchanged)
})
