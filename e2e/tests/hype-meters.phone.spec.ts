import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { mockHost } from './support/resources.js'

const host = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Host' })

async function openHealth(page: Page) {
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: /^Health/ })
    .tap()
  return page.getByRole('dialog', { name: 'Health' }).getByRole('button', { name: 'Resources' })
}

const BAR = { name: 'Host CPU and memory' }

test('the Health sheet shows one bar lit by a busy CPU, with both numbers, and the page fits', async ({ page }) => {
  await mockHost(page, { cpu: 100, memory: 62, rules: [] })
  await page.goto('/#agents')
  await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Health: all clear' })).toBeVisible()
  const row = await openHealth(page)
  await expect(row.getByRole('meter')).toHaveCount(1)
  const bar = row.getByRole('meter', BAR)
  await expect(bar).toHaveAttribute('data-hype', 'rage')
  await expect(bar).toHaveAttribute('aria-valuenow', '100')
  await expect(row).toHaveAttribute('data-tone', 'default')
  await expect(row).toContainText('CPU 100%, memory 62% of 30.0 GB.')
  await expect(row).toContainText('CPU drives the bar.')
  expect(await bar.locator('.hype-sweep').evaluate((sweep) => getComputedStyle(sweep).animationName)).toBe('hype-sweep')
  expect((await bar.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(48)
  await expectFitsPhone(page, 'the Health sheet')

  await row.tap()
  await expect(host(page).getByRole('meter', { name: 'Host CPU' })).toHaveAttribute('data-hype', 'rage')
  await expect(host(page).getByRole('meter', { name: 'Host memory' })).toHaveAttribute('data-hype', 'flow')
  await expectFitsPhone(page, 'the resources page')
})

test('memory well used alone lights the Health sheet bar, and reduced motion holds it still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockHost(page, { cpu: 14, memory: 86, rules: [] })
  await page.goto('/#agents')
  const row = await openHealth(page)
  const bar = row.getByRole('meter', BAR)
  await expect(bar).toHaveAttribute('data-hype', 'rage')
  await expect(bar).toHaveAttribute('aria-valuenow', '86')
  await expect(row).toContainText('Memory drives the bar.')
  const still = await bar.locator('.hype-sweep').evaluate((sweep) => {
    const style = getComputedStyle(sweep)
    return { animation: style.animationName, gradient: style.backgroundImage.startsWith('linear-gradient') }
  })
  expect(still).toEqual({ animation: 'none', gradient: true })
})

test('memory pressure warns in the Health sheet, beside its count, even with a full CPU', async ({ page }) => {
  await mockHost(page, { cpu: 100, memory: 97, rules: ['host_memory'] })
  await page.goto('/#agents')
  await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Health: 1 to check' })).toHaveAttribute(
    'data-tone',
    'warning',
  )
  const row = await openHealth(page)
  const bar = row.getByRole('meter', BAR)
  await expect(bar).toHaveAttribute('data-hype', 'warning')
  await expect(bar).toHaveAttribute('aria-valuenow', '97')
  await expect(bar.locator('.hype-sweep')).toHaveCount(0)
  await expect(row.getByTestId('resource-anomalies')).toHaveText('1')
  await expect(row).toContainText('Memory drives the bar as a warning: memory almost used up.')
  expect((await bar.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(24)
  await expectFitsPhone(page, 'the Health sheet')
})
