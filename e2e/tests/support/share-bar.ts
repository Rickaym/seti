import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { seedDashboard } from './render-dialog.js'

/** Long enough to overflow any bar, so the name has to truncate on one line. */
export const LONG_NAME = 'quarterly-infrastructure-cost-dashboard-for-every-region-and-team-final-v2.html'

/** The bar may not grow past this, on a desktop or a phone. */
const BAR_MAX_PX = 40

/** The smallest side of an icon action. */
const ACTION_MIN_PX = 32

/** The dashboard again under a name too long for one line. */
export function seedLongDashboard(dir: string): void {
  seedDashboard(dir)
  fs.copyFileSync(path.join(dir, 'docs', 'dashboard.html'), path.join(dir, 'docs', LONG_NAME))
}

/** The share's top bar: one line under 40 px, each action an icon link found by its name. */
export async function expectThinBar(page: Page, name: string, actions: readonly string[]): Promise<void> {
  const bar = page.locator('body > header')
  const box = await bar.boundingBox()
  test.info().annotations.push({ type: 'bar height', description: `${page.url()}: ${String(box?.height)}` })
  expect(box?.height ?? Infinity).toBeLessThan(BAR_MAX_PX)
  const title = bar.getByRole('heading', { level: 1, name })
  await expect(title).toHaveAttribute('title', new RegExp(`^${name.replaceAll('.', '\\.')}\\n.+, updated `))
  for (const label of actions) {
    const link = bar.getByRole('link', { name: label, exact: true })
    await expect(link).toBeVisible()
    await expect(link).toHaveText('')
    const { width = 0, height = 0 } = (await link.boundingBox()) ?? {}
    expect(Math.min(width, height), label).toBeGreaterThanOrEqual(ACTION_MIN_PX)
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

/** The rendered page and its code view, light and dark, each under one thin bar. */
export async function expectThinBars(page: Page, url: string, device: string, truncates: boolean): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(url)
    await expect(page.frameLocator('iframe.page').locator('#out')).toHaveText('Drawn by its script')
    await expectThinBar(page, LONG_NAME, ['View code', 'Download'])
    const title = page.getByRole('heading', { level: 1 })
    expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth), 'the name truncates').toBe(truncates)
    const fill = await page.evaluate(() => {
      const frame = document.querySelector('iframe.page')?.getBoundingClientRect()
      const root = document.documentElement
      return { bottom: frame?.bottom, height: root.clientHeight, scroll: root.scrollHeight - root.clientHeight }
    })
    expect(fill).toEqual({ bottom: fill.height, height: fill.height, scroll: 0 })
    await page.screenshot({ path: test.info().outputPath(`bar-${device}-${scheme}.png`) })
    await page.getByRole('link', { name: 'View code', exact: true }).click()
    await expect(page).toHaveURL(`${url}/code`)
    await expectThinBar(page, LONG_NAME, ['Download'])
    await page.screenshot({ path: test.info().outputPath(`code-${device}-${scheme}.png`) })
  }
}
