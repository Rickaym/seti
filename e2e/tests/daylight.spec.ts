import type { Locator } from '@playwright/test'
import { expect, test } from './support/fixtures.js'

async function rect(locator: Locator) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box ?? { x: 0, y: 0, width: 0, height: 0 }
}

test('header band spans the day from the logo to the header end and names the day in its label', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-06-21T14:30:00+02:00'))
  await page.goto('/')
  const header = page.getByRole('banner')
  const band = header.getByRole('img', { name: /^Daylight, 02:30 PM\. Sunrise 04:4\d AM, sunset 09:3\d PM$/ })
  await expect(band).toBeVisible()

  const logo = await rect(header.getByText('SETI', { exact: true }))
  const box = await rect(band)
  const headerBox = await rect(header)
  expect(box.x).toBeGreaterThan(logo.x + logo.width)
  expect(box.x + box.width).toBeLessThanOrEqual(headerBox.x + headerBox.width)
  expect(box.width).toBeGreaterThan(headerBox.width * 0.8)
  expect(headerBox.height).toBe(48)
  await expect(page.getByRole('contentinfo').getByRole('img', { name: /^Daylight/ })).toHaveCount(0)

  await band.hover()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
})
