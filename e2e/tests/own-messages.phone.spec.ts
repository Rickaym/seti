import type { Page } from '@playwright/test'
import { expect, test, unique } from './support/fixtures.js'
import { ask, reply, REPLIES, seedAsks, seedOwnMessages } from './support/own-messages.js'

const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })
const own = (page: Page, turn: number) =>
  transcript(page)
    .locator('[data-own-message]')
    .filter({ hasText: ask(turn) })

test('taps back through your own messages with full-size targets', async ({ page }) => {
  const id = await seedOwnMessages(unique('Phone own steps'))
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText(reply(4, REPLIES[3]))).toBeInViewport()
  const nav = page.getByTestId('own-message-nav')
  const back = nav.getByRole('button', { name: 'Previous message of yours' })
  const forward = nav.getByRole('button', { name: 'Next message of yours' })
  for (const button of [back, forward]) {
    const box = await button.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }

  await back.tap()
  await expect(own(page, 4)).toHaveAttribute('data-own-flash', '')
  await expect(own(page, 4)).toBeInViewport()
  await back.tap()
  await expect(own(page, 3)).toHaveAttribute('data-own-flash', '')
  await expect(own(page, 3)).toBeInViewport()
  await forward.tap()
  await expect(own(page, 4)).toHaveAttribute('data-own-flash', '')
  await expect(own(page, 4)).toBeInViewport()
})

test('taps back to your messages far outside the loaded rows', async ({ page }) => {
  test.setTimeout(60_000)
  const id = await seedAsks(unique('Phone own far'), [700, 300])
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText(reply(2, 300))).toBeInViewport()
  await expect(transcript(page).locator('[data-own-message]')).toHaveCount(0)
  const back = page.getByTestId('own-message-nav').getByRole('button', { name: 'Previous message of yours' })

  await back.tap()
  await expect(own(page, 2)).toHaveAttribute('data-own-flash', '')
  await expect(own(page, 2)).toBeInViewport()
  await back.tap()
  await expect(own(page, 1)).toHaveAttribute('data-own-flash', '')
  await expect(own(page, 1)).toBeInViewport()
  await expect(back).toBeDisabled()
})
