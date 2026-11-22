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

test('the Health sheet shows a busy host lit up, with its numbers, and the page fits', async ({ page }) => {
  await mockHost(page, { cpu: 100, memory: 62, rules: [] })
  await page.goto('/#agents')
  await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Health: all clear' })).toBeVisible()
  const row = await openHealth(page)
  const cpu = row.getByRole('meter', { name: 'Host CPU' })
  await expect(cpu).toHaveAttribute('data-hype', 'rage')
  await expect(row.getByRole('meter', { name: 'Host memory' })).toHaveAttribute('data-hype', 'flow')
  await expect(row).toHaveAttribute('data-tone', 'default')
  await expect(row).toContainText('Host memory 62% used, CPU 100%.')
  expect(await cpu.locator('.hype-sweep').evaluate((sweep) => getComputedStyle(sweep).animationName)).toBe('hype-sweep')
  expect((await cpu.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(24)
  await expectFitsPhone(page, 'the Health sheet')

  await row.tap()
  await expect(host(page).getByRole('meter', { name: 'Host CPU' })).toHaveAttribute('data-hype', 'rage')
  await expect(host(page).getByRole('meter', { name: 'Host memory' })).toHaveAttribute('data-hype', 'flow')
  await expectFitsPhone(page, 'the resources page')
})

test('memory pressure warns in the Health sheet, and reduced motion holds the lit CPU still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockHost(page, { cpu: 100, memory: 97, rules: ['host_memory'] })
  await page.goto('/#agents')
  await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Health: 1 to check' })).toHaveAttribute(
    'data-tone',
    'warning',
  )
  const row = await openHealth(page)
  const memory = row.getByRole('meter', { name: 'Host memory' })
  await expect(memory).toHaveAttribute('data-hype', 'warning')
  await expect(memory.locator('.hype-sweep')).toHaveCount(0)
  const cpu = row.getByRole('meter', { name: 'Host CPU' })
  await expect(cpu).toHaveAttribute('data-hype', 'rage')
  const still = await cpu.locator('.hype-sweep').evaluate((sweep) => {
    const style = getComputedStyle(sweep)
    return { animation: style.animationName, gradient: style.backgroundImage.startsWith('linear-gradient') }
  })
  expect(still).toEqual({ animation: 'none', gradient: true })
})
