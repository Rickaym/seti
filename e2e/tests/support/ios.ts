import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.js'

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

/** An iPhone with a Dynamic Island in portrait, its status bar over the page as with translucent. */
export const PORTRAIT: Insets = { top: 59, right: 0, bottom: 34, left: 0 }

/** Sets what `env(safe-area-inset-*)` reads, as iOS does for a page with `viewport-fit=cover`. */
export async function safeAreas(page: Page, insets: Insets): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets })
}

/** Makes the page believe it was opened from the Home Screen, as iOS reports it. */
export async function homeScreenApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => true })
  })
}

/** Records each app badge the page sets, with 0 for a cleared one. */
export async function recordBadges(page: Page): Promise<() => Promise<number[]>> {
  await page.addInitScript(() => {
    const shown: number[] = []
    Reflect.set(window, 'setiBadges', shown)
    Navigator.prototype.setAppBadge = async (count?: number) => {
      shown.push(count ?? 0)
      return Promise.resolve()
    }
    Navigator.prototype.clearAppBadge = async () => {
      shown.push(0)
      return Promise.resolve()
    }
  })
  return async () => page.evaluate(() => [...(Reflect.get(window, 'setiBadges') as number[])])
}

/** Expects the element's box to stay inside the area the insets leave free. */
export async function expectClear(page: Page, locator: Locator, insets: Insets, what: string): Promise<void> {
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()
  expect(box, what).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (box === null || viewport === null) {
    return
  }
  expect(box.y, `${what} top`).toBeGreaterThanOrEqual(insets.top)
  expect(box.y + box.height, `${what} bottom`).toBeLessThanOrEqual(viewport.height - insets.bottom + 0.5)
  expect(box.x, `${what} left`).toBeGreaterThanOrEqual(insets.left)
  expect(box.x + box.width, `${what} right`).toBeLessThanOrEqual(viewport.width - insets.right + 0.5)
}
