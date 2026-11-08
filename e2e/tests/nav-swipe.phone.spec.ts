import type { CDPSession, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'

/** A quick one-finger drag across the page at height y, from x `from` to x `to`. */
async function swipe(cdp: CDPSession, y: number, from: number, to: number): Promise<void> {
  const steps = 6
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] })
  for (let step = 1; step <= steps; step++) {
    const x = from + ((to - from) * step) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

const drawer = (page: Page) => page.getByRole('dialog').getByRole('navigation', { name: 'Sections' })

test('a swipe right opens the menu and a swipe left on it closes it', async ({ page }) => {
  await page.goto('/#settings')
  await expect(page.getByRole('main').getByRole('navigation', { name: 'Settings pages' })).toBeVisible()
  const cdp = await page.context().newCDPSession(page)

  await swipe(cdp, 400, 120, 125)
  await expect(drawer(page)).toBeHidden()

  await swipe(cdp, 400, 20, 220)
  await expect(drawer(page)).toBeVisible()

  await swipe(cdp, 400, 220, 40)
  await expect(drawer(page)).toBeHidden()
})

test('a swipe that starts in a text field stays with the field', async ({ page }) => {
  await page.goto('/#settings/ea')
  const cdp = await page.context().newCDPSession(page)
  const field = page.getByRole('main').getByRole('textbox', { name: 'Address as' })
  await field.scrollIntoViewIfNeeded()
  const box = await field.boundingBox()
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2
  const left = (box?.x ?? 0) + 4

  await swipe(cdp, y, left, left + 200)
  await expect(drawer(page)).toBeHidden()
})
