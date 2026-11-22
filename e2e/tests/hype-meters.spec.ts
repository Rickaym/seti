import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { mockHost } from './support/resources.js'

const item = (page: Page) => page.getByRole('contentinfo').getByRole('button', { name: 'Resources' })
const host = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Host' })

/** The moving part of a meter's fill: its animation, and whether it still paints a gradient. */
const sweep = async (meter: Locator) =>
  meter.locator('.hype-sweep').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      animation: style.animationName,
      seconds: parseFloat(style.animationDuration),
      gradient: style.backgroundImage.startsWith('linear-gradient'),
    }
  })

test('a busy, healthy host lights the status bar meters up without a warning', async ({ page }) => {
  await mockHost(page, { cpu: 100, memory: 62, rules: [] })
  await page.goto('/#agents')
  const cpu = item(page).getByRole('meter', { name: 'Host CPU' })
  const memory = item(page).getByRole('meter', { name: 'Host memory' })
  await expect(cpu).toHaveAttribute('data-hype', 'rage')
  await expect(cpu).toHaveAttribute('aria-valuenow', '100')
  await expect(memory).toHaveAttribute('data-hype', 'flow')
  await expect(item(page)).toHaveAttribute('data-tone', 'default')
  await expect(item(page).getByTestId('resource-anomalies')).toHaveCount(0)

  const raging = await sweep(cpu)
  const flowing = await sweep(memory)
  expect(raging).toMatchObject({ animation: 'hype-sweep', gradient: true })
  expect(flowing).toMatchObject({ animation: 'hype-sweep', gradient: true })
  expect(raging.seconds).toBeLessThan(flowing.seconds)

  const moving = await item(page).evaluate((element) =>
    element.getAnimations({ subtree: true }).map((animation) => {
      const effect = animation.effect as KeyframeEffect
      return effect.getKeyframes().flatMap((frame) => Object.keys(frame))
    }),
  )
  expect(moving).toHaveLength(2)
  for (const properties of moving) {
    expect(properties.filter((name) => !['offset', 'easing', 'composite', 'computedOffset'].includes(name))).toEqual([
      'transform',
    ])
  }

  await item(page).hover()
  await expect(page.getByRole('tooltip')).toContainText('Host memory 62% used, CPU 100%.')
})

test('a quiet host shows calm meters that do not move', async ({ page }) => {
  await mockHost(page, { cpu: 12, memory: 30, rules: [] })
  await page.goto('/#agents')
  const cpu = item(page).getByRole('meter', { name: 'Host CPU' })
  await expect(cpu).toHaveAttribute('data-hype', 'calm')
  await expect(item(page).getByRole('meter', { name: 'Host memory' })).toHaveAttribute('data-hype', 'calm')
  await expect(item(page).locator('.hype-sweep')).toHaveCount(0)
  expect(await item(page).evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0)
})

test('memory under pressure is a still warning while the full CPU beside it stays lit', async ({ page }) => {
  await mockHost(page, { cpu: 100, memory: 97, rules: ['host_memory'] })
  await page.goto('/#agents')
  const memory = item(page).getByRole('meter', { name: 'Host memory' })
  await expect(memory).toHaveAttribute('data-hype', 'warning')
  await expect(memory.locator('.hype-sweep')).toHaveCount(0)
  await expect(item(page).getByRole('meter', { name: 'Host CPU' })).toHaveAttribute('data-hype', 'rage')
  await expect(item(page)).toHaveAttribute('data-tone', 'warning')
  await expect(item(page).getByTestId('resource-anomalies')).toHaveText('1')
  const colours = await memory.locator('.hype-fill').evaluate((fill) => ({
    fill: getComputedStyle(fill).backgroundColor,
    text: getComputedStyle(fill.closest('button') ?? fill).color,
  }))
  expect(colours.fill).toBe(colours.text)

  await item(page).click()
  await expect(host(page).getByRole('meter', { name: 'Host memory' })).toHaveAttribute('data-hype', 'warning')
  await expect(host(page).getByRole('meter', { name: 'Host CPU' })).toHaveAttribute('data-hype', 'rage')
  await expect(host(page).getByRole('group', { name: 'Memory' })).toContainText('97%')
})

test('an overloaded run queue warns on the CPU meter, and swap nearly full on memory', async ({ page }) => {
  await mockHost(page, { cpu: 100, memory: 55, rules: ['load', 'swap'] })
  await page.goto('/#settings/resources')
  await expect(host(page).getByRole('meter', { name: 'Host CPU' })).toHaveAttribute('data-hype', 'warning')
  await expect(host(page).getByRole('meter', { name: 'Host memory' })).toHaveAttribute('data-hype', 'warning')
  await expect(host(page).locator('.hype-sweep')).toHaveCount(0)
})

test('the resources page meters flow and rage, and hold still for reduced motion', async ({ page }) => {
  await mockHost(page, { cpu: 96, memory: 64, rules: [] })
  await page.goto('/#settings/resources')
  const cpu = host(page).getByRole('meter', { name: 'Host CPU' })
  const memory = host(page).getByRole('meter', { name: 'Host memory' })
  await expect(cpu).toHaveAttribute('data-hype', 'rage')
  await expect(memory).toHaveAttribute('data-hype', 'flow')
  expect(await sweep(cpu)).toMatchObject({ animation: 'hype-sweep', gradient: true })
  const track = await cpu.boundingBox()
  const fill = await cpu.locator('.hype-fill').boundingBox()
  expect((fill?.width ?? 0) / (track?.width ?? 1)).toBeCloseTo(0.96, 1)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await sweep(cpu)).toMatchObject({ animation: 'none', gradient: true })
  expect(await sweep(memory)).toMatchObject({ animation: 'none', gradient: true })
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  for (const meter of [item(page).getByRole('meter', { name: 'Host CPU' }), cpu]) {
    await expect(meter).toHaveAttribute('data-hype', 'rage')
  }
})
