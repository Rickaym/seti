import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { mockHost } from './support/resources.js'

const item = (page: Page) => page.getByRole('contentinfo').getByRole('button', { name: 'Resources' })
const bar = (page: Page) => item(page).getByRole('meter', { name: 'Host CPU and memory' })
const host = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Host' })

/** The moving part of a meter's fill: its animation, and whether it still paints a gradient. */
const sweep = async (meter: Locator) =>
  meter.locator('.hype-sweep').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      animation: style.animationName,
      seconds: parseFloat(style.animationDuration),
      stepped: style.animationTimingFunction.startsWith('steps'),
      gradient: style.backgroundImage.startsWith('linear-gradient'),
    }
  })

test('one bar stands for CPU and memory, and a full CPU alone makes it rage without a warning', async ({ page }) => {
  await mockHost(page, { cpu: 100, memory: 42, rules: [] })
  await page.goto('/#agents')
  await expect(item(page).getByRole('meter')).toHaveCount(1)
  await expect(bar(page)).toHaveAttribute('data-hype', 'rage')
  await expect(bar(page)).toHaveAttribute('aria-valuenow', '100')
  await expect(item(page)).toHaveAttribute('data-tone', 'default')
  await expect(item(page).getByTestId('resource-anomalies')).toHaveCount(0)
  expect((await bar(page).boundingBox())?.width).toBe(56)
  expect(await sweep(bar(page))).toMatchObject({ animation: 'hype-sweep', gradient: true, stepped: true, seconds: 1.2 })

  const moving = await item(page).evaluate((element) =>
    element.getAnimations({ subtree: true }).map((animation) => {
      const effect = animation.effect as KeyframeEffect
      return effect.getKeyframes().flatMap((frame) => Object.keys(frame))
    }),
  )
  expect(moving).toHaveLength(1)
  const meta = ['offset', 'easing', 'composite', 'computedOffset']
  expect([...new Set(moving.flat().filter((name) => !meta.includes(name)))]).toEqual(['transform'])

  await item(page).hover()
  await expect(page.getByRole('tooltip')).toContainText('CPU 100%, memory 42% of 30.0 GB.')
  await expect(page.getByRole('tooltip')).toContainText('CPU drives the bar.')
})

test('memory well used alone makes the bar rage too, and half use of either makes it flow', async ({ page }) => {
  await mockHost(page, { cpu: 14, memory: 86, rules: [] })
  await page.goto('/#agents')
  await expect(bar(page)).toHaveAttribute('data-hype', 'rage')
  await expect(bar(page)).toHaveAttribute('aria-valuenow', '86')
  await item(page).hover()
  await expect(page.getByRole('tooltip')).toContainText('CPU 14%, memory 86% of 30.0 GB.')
  await expect(page.getByRole('tooltip')).toContainText('Memory drives the bar.')

  await mockHost(page, { cpu: 63, memory: 20, rules: [] })
  await page.reload()
  await expect(bar(page)).toHaveAttribute('data-hype', 'flow')
  await expect(bar(page)).toHaveAttribute('aria-valuenow', '63')
  expect(await sweep(bar(page))).toMatchObject({ animation: 'hype-sweep', gradient: true, stepped: true, seconds: 6 })
  const track = await bar(page).boundingBox()
  const fill = await bar(page).locator('.hype-fill').boundingBox()
  expect((fill?.width ?? 0) / (track?.width ?? 1)).toBeCloseTo(0.63, 1)
})

test('a quiet host shows a calm bar that does not move', async ({ page }) => {
  await mockHost(page, { cpu: 12, memory: 30, rules: [] })
  await page.goto('/#agents')
  await expect(bar(page)).toHaveAttribute('data-hype', 'calm')
  await expect(bar(page)).toHaveAttribute('aria-valuenow', '30')
  await expect(item(page).locator('.hype-sweep')).toHaveCount(0)
  expect(await item(page).evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0)
})

test('memory under pressure holds the bar still as a warning, even beside a full CPU', async ({ page }) => {
  await mockHost(page, { cpu: 100, memory: 97, rules: ['host_memory'] })
  await page.goto('/#agents')
  await expect(bar(page)).toHaveAttribute('data-hype', 'warning')
  await expect(bar(page)).toHaveAttribute('aria-valuenow', '97')
  await expect(item(page).locator('.hype-sweep')).toHaveCount(0)
  await expect(item(page)).toHaveAttribute('data-tone', 'warning')
  await expect(item(page).getByTestId('resource-anomalies')).toHaveText('1')
  const colours = await bar(page)
    .locator('.hype-fill')
    .evaluate((fill) => ({
      fill: getComputedStyle(fill).backgroundColor,
      text: getComputedStyle(fill.closest('button') ?? fill).color,
    }))
  expect(colours.fill).toBe(colours.text)
  await item(page).hover()
  await expect(page.getByRole('tooltip')).toContainText('Memory drives the bar as a warning: memory almost used up.')

  await item(page).click()
  await expect(host(page).getByRole('meter', { name: 'Host memory' })).toHaveAttribute('data-hype', 'warning')
  await expect(host(page).getByRole('meter', { name: 'Host CPU' })).toHaveAttribute('data-hype', 'rage')
  await expect(host(page).getByRole('group', { name: 'Memory' })).toContainText('97%')
})

test('an overloaded run queue and swap nearly full warn on the bar and on each page meter', async ({ page }) => {
  await mockHost(page, { cpu: 100, memory: 55, rules: ['load', 'swap'] })
  await page.goto('/#settings/resources')
  await expect(host(page).getByRole('meter', { name: 'Host CPU' })).toHaveAttribute('data-hype', 'warning')
  await expect(host(page).getByRole('meter', { name: 'Host memory' })).toHaveAttribute('data-hype', 'warning')
  await expect(host(page).locator('.hype-sweep')).toHaveCount(0)
  await expect(bar(page)).toHaveAttribute('data-hype', 'warning')
  await expect(bar(page)).toHaveAttribute('aria-valuenow', '100')
  await item(page).hover()
  await expect(page.getByRole('tooltip')).toContainText(
    'CPU drives the bar as a warning: run queue overloaded, swap almost full.',
  )
})

test('the resources page meters flow and rage, and hold still for reduced motion', async ({ page }) => {
  await mockHost(page, { cpu: 96, memory: 64, rules: [] })
  await page.goto('/#settings/resources')
  const cpu = host(page).getByRole('meter', { name: 'Host CPU' })
  const memory = host(page).getByRole('meter', { name: 'Host memory' })
  await expect(cpu).toHaveAttribute('data-hype', 'rage')
  await expect(memory).toHaveAttribute('data-hype', 'flow')
  expect(await sweep(cpu)).toMatchObject({ animation: 'hype-sweep', gradient: true, stepped: false })
  const track = await cpu.boundingBox()
  const fill = await cpu.locator('.hype-fill').boundingBox()
  expect((fill?.width ?? 0) / (track?.width ?? 1)).toBeCloseTo(0.96, 1)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await sweep(cpu)).toMatchObject({ animation: 'none', gradient: true })
  expect(await sweep(memory)).toMatchObject({ animation: 'none', gradient: true })
  const running = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((animation) => (animation.effect as KeyframeEffect).target?.classList.contains('hype-sweep') === true)
        .length,
  )
  expect(running).toBe(0)
  for (const meter of [bar(page), cpu]) {
    await expect(meter).toHaveAttribute('data-hype', 'rage')
  }
})
