import type { BrowserContext, Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, terminalIn, terminalInput, typedInput } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const LINK = 'https://example.com/seti-docs'

async function openTerminal(page: Page, context: BrowserContext): Promise<Locator> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await context.route('https://example.com/**', async (route) => route.fulfill({ body: 'docs' }))
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  return terminalIn(page)
}

/** The point a few px into the first cell of the row that starts with `text`. */
async function rowStart(terminal: Locator, text: string): Promise<{ x: number; y: number }> {
  const row = screenOf(terminal)
    .locator('> div')
    .filter({ hasText: new RegExp(`^${text}`, 'u') })
  const box = await row.last().boundingBox()
  return { x: (box?.x ?? 0) + 6, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 }
}

test('a long press selects a word to copy, and Paste sends the clipboard to the shell', async ({ page, context }) => {
  const terminal = await openTerminal(page, context)
  const sent = typedInput(page)
  await run(terminal, 'echo copy-$((6*7))-done')
  await expect(
    screenOf(terminal)
      .locator('> div')
      .filter({ hasText: /^copy-42-done/u }),
  ).toBeVisible()
  const at = await rowStart(terminal, 'copy-42-done')
  const cdp = await page.context().newCDPSession(page)
  const before = sent.length

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
  await expect(terminal.locator('.xterm-selection > div').first()).toBeVisible()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const bar = terminal.getByRole('toolbar', { name: 'Selection' })
  await expect(bar.getByRole('button')).toHaveText(['Copy', 'Paste', ''])
  await bar.getByRole('button', { name: 'Copy' }).tap()
  await expect(bar).toHaveCount(0)
  await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toBe('copy-42-done')
  expect(sent.length, 'selecting sends the shell nothing').toBe(before)

  await page.evaluate(async () => navigator.clipboard.writeText('echo pasted-$((5*5))'))
  const keys = terminal.getByRole('toolbar', { name: 'Terminal keys' })
  await keys.getByRole('button', { name: 'Paste' }).tap()
  await expect.poll(() => sent.slice(before).join('')).toContain('echo pasted-$((5*5))')
  await terminalInput(terminal).press('Enter')
  await expect(screenOf(terminal)).toContainText('pasted-25')
})

test('a link opens from a tap, or from a long press and Open', async ({ page, context }) => {
  const terminal = await openTerminal(page, context)
  await run(terminal, `clear; echo ${LINK}`)
  await expect(
    screenOf(terminal)
      .locator('> div')
      .filter({ hasText: new RegExp(`^${LINK}`, 'u') }),
  ).toBeVisible()
  const at = await rowStart(terminal, LINK)

  const tapped = page.waitForEvent('popup')
  await page.touchscreen.tap(at.x + 20, at.y)
  const first = await tapped
  await expect(first).toHaveURL(LINK)
  await first.close()

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
  await expect(terminal.locator('.xterm-selection > div').first()).toBeVisible()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const opened = page.waitForEvent('popup')
  await terminal.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Open' }).tap()
  await expect(await opened).toHaveURL(LINK)
})
