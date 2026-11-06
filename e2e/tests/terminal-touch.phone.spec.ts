import type { CDPSession, Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, screenRows, shellRows, terminalIn, terminalInput, typedInput } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

async function openTerminal(page: Page): Promise<Locator> {
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  return terminalIn(page)
}

/** The number on the terminal's top row, as `seq` printed it. */
const topNumber = async (terminal: Locator) =>
  Number((await screenOf(terminal).locator('> div').first().innerText()).trim())

/** A quick one-finger drag on the terminal's screen, from `from` to `to` px below its top. */
async function swipe(cdp: CDPSession, screen: Locator, from: number, to: number): Promise<void> {
  const steps = 8
  const box = await screen.boundingBox()
  const x = (box?.x ?? 0) + 100
  const top = box?.y ?? 0
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: top + from }] })
  for (let step = 1; step <= steps; step++) {
    const y = top + from + ((to - from) * step) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

const focusedTag = async (page: Page) => page.evaluate(() => document.activeElement?.tagName ?? '')

test('a swipe scrolls back through the output, flings on and never raises the keyboard', async ({ page }) => {
  const terminal = await openTerminal(page)
  const sent = typedInput(page)
  await run(terminal, 'seq 1 600')
  await expect(screenOf(terminal)).toContainText('600')
  const input = terminalInput(terminal)
  await input.blur()
  const screen = terminal.locator('.xterm-screen')
  const cdp = await page.context().newCDPSession(page)
  const sentBefore = sent.length
  const bottom = await topNumber(terminal)

  await swipe(cdp, screen, 100, 500)
  await expect.poll(async () => bottom - (await topNumber(terminal)), 'a 400px drag scrolls back').toBeGreaterThan(15)
  expect(await focusedTag(page)).not.toMatch(/^(INPUT|TEXTAREA)$/u)
  expect(sent.length, 'scrolling the output sends the shell nothing').toBe(sentBefore)

  await swipe(cdp, screen, 400, 100)
  const lifted = await topNumber(terminal)
  await expect
    .poll(async () => topNumber(terminal), { message: 'the fling scrolls on after the lift' })
    .toBeGreaterThan(lifted)
  expect(await focusedTag(page)).not.toMatch(/^(INPUT|TEXTAREA)$/u)

  await screen.tap()
  await expect(input).toBeFocused()
})

test('a swipe in a full-screen program sends it arrow keys, as a wheel does', async ({ page }) => {
  const terminal = await openTerminal(page)
  const sent = typedInput(page)
  await run(terminal, 'seq 1 300 | less')
  await expect(screenOf(terminal)).toContainText(':')
  await expect.poll(async () => topNumber(terminal)).toBe(1)
  const cdp = await page.context().newCDPSession(page)
  const before = sent.length

  await swipe(cdp, terminal.locator('.xterm-screen'), 400, 100)
  await expect.poll(async () => topNumber(terminal)).toBeGreaterThan(5)
  const arrows = sent.slice(before)
  expect(arrows.length).toBeGreaterThan(5)
  expect(new Set(arrows)).toEqual(new Set(['\x1bOB']))

  await terminalInput(terminal).press('q')
  await run(terminal, 'echo out-$((4+4))')
  await expect(screenOf(terminal)).toContainText('out-8')
})

test('two fingers spreading on the terminal grow its font, and the shell hears the new size', async ({ page }) => {
  const terminal = await openTerminal(page)
  await run(terminal, 'echo ready-$((1+1))')
  await expect(screenOf(terminal)).toContainText('ready-2')
  const resting = (await screenRows(terminal)).drawn
  const box = await terminal.locator('.xterm-screen').boundingBox()
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2
  const y = (box?.y ?? 0) + 200
  const cdp = await page.context().newCDPSession(page)
  const fingers = (gap: number) => [
    { x, y: y - gap, id: 0 },
    { x, y: y + gap, id: 1 },
  ]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(40) })
  for (const gap of [50, 60, 70, 80]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(gap) })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  await expect.poll(async () => (await screenRows(terminal)).drawn).toBeLessThan(resting - 5)
  expect(await shellRows(terminal)).toBe((await screenRows(terminal)).drawn)
  await page.reload()
  await expect.poll(async () => (await screenRows(terminal)).drawn).toBeLessThan(resting - 5)
})
