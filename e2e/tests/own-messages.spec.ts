import type { Page } from '@playwright/test'
import { expect, test, unique } from './support/fixtures.js'
import { ask, reply, REPLIES, seedAsks, seedOwnMessages } from './support/own-messages.js'
import { seedLoadingTask } from './support/transcript-loading.js'

const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })
const nav = (page: Page) => page.getByTestId('own-message-nav')
const back = (page: Page) => nav(page).getByRole('button', { name: 'Previous message of yours' })
const forward = (page: Page) => nav(page).getByRole('button', { name: 'Next message of yours' })
const own = (page: Page, turn: number) =>
  transcript(page)
    .locator('[data-own-message]')
    .filter({ hasText: ask(turn) })

/** How far the ask sits below the top of the transcript's view. */
async function offset(page: Page, turn: number): Promise<number> {
  const [box, pane] = await Promise.all([own(page, turn).boundingBox(), transcript(page).boundingBox()])
  return box === null || pane === null ? Number.NaN : box.y - pane.y
}

/** The step landed on the ask: it sits at the top of the view, ringed. */
async function expectLanded(page: Page, turn: number): Promise<void> {
  await expect(own(page, turn)).toHaveAttribute('data-own-flash', '')
  await expect.poll(async () => offset(page, turn)).toBeGreaterThanOrEqual(0)
  await expect.poll(async () => offset(page, turn)).toBeLessThan(40)
}

test('steps back through your own messages past the loaded page, then forward to the latest', async ({ page }) => {
  test.setTimeout(60_000)
  const id = await seedOwnMessages(unique('Own steps'))
  const earlier: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/api/tasks/${id}/messages` && url.searchParams.has('before')) {
      earlier.push(url.search)
    }
  })
  await page.goto(`/#agents/${id}`)
  const newest = transcript(page).getByText(reply(4, REPLIES[3]))
  await expect(newest).toBeInViewport()
  await expect(back(page)).toHaveAttribute('aria-keyshortcuts', 'Alt+[')
  await expect(forward(page)).toBeDisabled()

  await back(page).click()
  await expectLanded(page, 4)
  await expect(newest).not.toBeInViewport()
  await back(page).click()
  await expectLanded(page, 3)
  await back(page).click()
  await expectLanded(page, 2)
  await expect(nav(page)).not.toContainText('/')

  await back(page).click()
  await expectLanded(page, 1)
  expect(earlier.length).toBeGreaterThan(0)
  await expect(nav(page)).toContainText('1/4')
  await expect(back(page)).toBeDisabled()

  await forward(page).click()
  await expectLanded(page, 2)
  await expect(nav(page)).toContainText('2/4')
  await page.keyboard.press('Alt+BracketRight')
  await expectLanded(page, 3)
  await page.keyboard.press('Alt+BracketLeft')
  await expectLanded(page, 2)

  await forward(page).click()
  await forward(page).click()
  await expectLanded(page, 4)
  await forward(page).click()
  await expect(newest).toBeInViewport()
  await expect(forward(page)).toBeDisabled()
})

test('reaches your messages far outside the loaded rows, with none of them loaded', async ({ page }) => {
  test.setTimeout(60_000)
  const id = await seedAsks(unique('Own far'), [700, 300])
  const lookups: string[] = []
  const pages: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/api/tasks/${id}/own-message`) {
      lookups.push(url.search)
    } else if (url.pathname === `/api/tasks/${id}/messages` && url.search !== '') {
      pages.push(url.search)
    }
  })
  await page.goto(`/#agents/${id}`)
  const newest = transcript(page).getByText(reply(2, 300))
  await expect(newest).toBeInViewport()
  await expect(transcript(page).locator('[data-own-message]')).toHaveCount(0)
  await expect(forward(page)).toBeDisabled()

  await back(page).click()
  await expectLanded(page, 2)
  expect(pages.some((search) => search.includes('before=') && search.includes('limit='))).toBe(true)
  await expect(newest).toHaveCount(1)

  await page.keyboard.press('Alt+BracketLeft')
  await expectLanded(page, 1)
  expect(pages.some((search) => search.includes('around='))).toBe(true)
  await expect(back(page)).toBeDisabled()
  expect(lookups).toHaveLength(2)

  await forward(page).click()
  await expectLanded(page, 2)
  await forward(page).click()
  await expect(newest).toBeInViewport()
  await expect(forward(page)).toBeDisabled()
})

test('stays away while every message of yours is in view', async ({ page }) => {
  const { id, reply: last } = await seedLoadingTask(unique('Own steps short'))
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText(last)).toBeVisible()
  await expect(transcript(page).locator('[data-own-message]')).toHaveCount(1)
  await expect(nav(page)).toHaveCount(0)
})
