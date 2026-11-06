import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'

interface Strip {
  visible: boolean
  x: number
  y: number
  width: number
  height: number
}

const WINDOWS: Strip = { visible: true, x: 0, y: 0, width: 1302, height: 33 }
const MAC: Strip = { visible: true, x: 78, y: 0, width: 1362, height: 28 }
const HIDDEN: Strip = { visible: false, x: 0, y: 0, width: 0, height: 0 }

/** Headless Chromium has the overlay object but never shows it, so its answers come from here. */
function stubOverlay(initial: Strip): void {
  const overlay = Reflect.get(navigator, 'windowControlsOverlay') as EventTarget
  let strip = initial
  Object.defineProperty(overlay, 'visible', { get: () => strip.visible })
  Object.defineProperty(overlay, 'getTitlebarAreaRect', {
    value: () => new DOMRect(strip.x, strip.y, strip.width, strip.height),
  })
  Reflect.set(window, 'setTitlebarStrip', (next: Strip) => {
    strip = next
    overlay.dispatchEvent(new Event('geometrychange'))
  })
}

async function setStrip(page: Page, strip: Strip): Promise<void> {
  await page.evaluate((next) => {
    const set = Reflect.get(window, 'setTitlebarStrip') as (value: Strip) => void
    set(next)
  }, strip)
}

async function rect(locator: Locator) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box ?? { x: 0, y: 0, width: 0, height: 0 }
}

const appRegion = async (locator: Locator) =>
  locator.evaluate((node) => getComputedStyle(node).getPropertyValue('app-region'))

test('the header keeps its height from the top edge, under the title bar, clear of the window buttons', async ({
  page,
}) => {
  await page.addInitScript(stubOverlay, WINDOWS)
  await page.goto('/')
  const header = page.getByRole('banner')
  const band = header.getByRole('img', { name: /^Daylight/ })
  await expect(page.locator('html')).toHaveAttribute('data-titlebar', 'overlay')

  const headerBox = await rect(header)
  expect(headerBox.y).toBe(0)
  expect(headerBox.height).toBe(48)
  const bandBox = await rect(band)
  expect(bandBox.y).toBe(0)
  expect(bandBox.height).toBeGreaterThan(WINDOWS.height)
  expect((await rect(header.getByText('SETI', { exact: true }))).x).toBeGreaterThanOrEqual(16)
  expect(bandBox.x + bandBox.width).toBeLessThanOrEqual(WINDOWS.width - 8)

  expect(await appRegion(header)).toBe('drag')
})

test('the header follows the strip as it changes and returns when the OS title bar does', async ({ page }) => {
  await page.addInitScript(stubOverlay, WINDOWS)
  await page.goto('/')
  const header = page.getByRole('banner')
  const logo = header.getByText('SETI', { exact: true })
  await expect(page.locator('html')).toHaveAttribute('data-titlebar', 'overlay')

  await setStrip(page, MAC)
  await expect.poll(async () => (await rect(header)).height).toBe(48)
  expect((await rect(logo)).x).toBeGreaterThanOrEqual(MAC.x + 16)

  await setStrip(page, HIDDEN)
  await expect(page.locator('html')).not.toHaveAttribute('data-titlebar')
  await expect.poll(async () => (await rect(header)).height).toBe(48)
  expect((await rect(logo)).x).toBe(16)
  expect(await appRegion(header)).toBe('none')
})

test('a browser tab keeps the usual header', async ({ page }) => {
  await page.goto('/')
  const header = page.getByRole('banner')
  await expect(header.getByRole('img', { name: /^Daylight/ })).toBeVisible()
  await expect(page.locator('html')).not.toHaveAttribute('data-titlebar')
  expect((await rect(header)).height).toBe(48)
  expect(await appRegion(header)).toBe('none')
})

test('the menu and its drawer take clicks over the title bar in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 })
  await page.addInitScript(stubOverlay, { ...WINDOWS, width: 562 })
  await page.goto('/')
  const menu = page.getByRole('banner').getByRole('button', { name: 'Menu' })
  expect(await appRegion(menu)).toBe('no-drag')
  await menu.click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  expect(await appRegion(drawer)).toBe('no-drag')
})
