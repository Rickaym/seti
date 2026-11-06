import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'

const PHRASE = 'Swarms of Extra Tactical Individuals'

const header = (page: Page) => page.getByRole('banner')
const logo = (page: Page) => header(page).getByRole('img', { name: 'SETI', exact: true })
const phrase = (page: Page) => header(page).getByText(PHRASE, { exact: true }).filter({ visible: true })

async function rect(locator: Locator) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box ?? { x: 0, y: 0, width: 0, height: 0 }
}

test('hovering the logo spells out SETI over the band without moving it, and leaving folds it back', async ({
  page,
}) => {
  await page.goto('/')
  await expect(logo(page)).toHaveAccessibleDescription(PHRASE)
  // The logo font narrows SETI by about 2px when it swaps in, which moves the band.
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  const band = header(page).getByRole('img', { name: /^Daylight/ })
  const before = await rect(band)
  await expect(phrase(page)).toHaveCount(0)

  await logo(page).hover()
  await expect(phrase(page)).toBeVisible()
  expect(await rect(band)).toEqual(before)
  expect(await rect(header(page))).toMatchObject({ height: 48 })

  await page.mouse.move(700, 600)
  await expect(phrase(page)).toHaveCount(0)
  await expect(header(page).getByText('SETI', { exact: true })).toBeVisible()
})

test('the spelled-out phrase keeps the logo ink, with no accent colour or glow', async ({ page }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.goto('/')
    const ink = await header(page)
      .getByText('SETI', { exact: true })
      .evaluate((node) => getComputedStyle(node).color)
    await logo(page).hover()
    await expect(phrase(page)).toBeVisible()
    await expect(header(page).locator('[data-state="wait"], [data-state="noise"]')).toHaveCount(0)
    const inks = await phrase(page)
      .locator('*')
      .evaluateAll((nodes) =>
        nodes.map((node) => `${getComputedStyle(node).color} ${getComputedStyle(node).textShadow}`),
      )
    expect(new Set(inks)).toEqual(new Set([`${ink} none`]))
    await page.mouse.move(700, 600)
  }
})

test('keyboard focus spells out SETI and Escape folds it back', async ({ page }) => {
  await page.goto('/')
  await expect(logo(page)).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(logo(page)).toBeFocused()
  await expect(phrase(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(phrase(page)).toHaveCount(0)
})

test('with reduced motion the phrase still shows on hover', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await logo(page).hover()
  await expect(phrase(page)).toBeVisible()
  await page.mouse.move(700, 600)
  await expect(phrase(page)).toHaveCount(0)
})
