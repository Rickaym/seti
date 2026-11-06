import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { Gboard } from './support/gboard.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, terminalIn, terminalInput, typedInput } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

/** Opens a terminal alone from the menu, waits for its prompt and returns it with its key bar. */
async function openTerminal(page: Page): Promise<{ terminal: Locator; keys: Locator; input: Locator }> {
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  const terminal = terminalIn(page)
  await expect(terminal.getByText('Connecting...')).toHaveCount(0)
  await expect(screenOf(terminal)).toContainText('$ ')
  const input = terminalInput(terminal)
  await input.focus()
  return { terminal, keys: terminal.getByRole('toolbar', { name: 'Terminal keys' }), input }
}

/** Where tmux is on this machine's PATH, or null where it is not installed. */
function tmuxPath(): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter)
  return dirs.map((dir) => path.join(dir, 'tmux')).find((file) => fs.existsSync(file)) ?? null
}

/** Waits until the shell got exactly `expected` since `from`, as separate input messages. */
async function expectSent(sent: string[], from: number, expected: string[]): Promise<void> {
  await expect.poll(() => sent.slice(from)).toEqual(expected)
}

test('the key bar sends Termius-style keys, with Ctrl and Alt for the next key only', async ({ page }) => {
  const sent = typedInput(page)
  const { keys, input } = await openTerminal(page)
  const key = (name: string) => keys.getByRole('button', { name, exact: true })
  const ctrl = key('Control')
  const alt = key('Alt')
  await expect(keys.getByRole('button')).toHaveText([
    'Esc',
    'Tab',
    'Ctrl',
    'Alt',
    '',
    '',
    '',
    '',
    '',
    '|',
    '~',
    '/',
    '-',
    '_',
    ':',
    ';',
    'Home',
    'End',
    'PgUp',
    'PgDn',
    '',
  ])
  for (const button of await keys.getByRole('button').all()) {
    const box = await button.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(box?.width).toBeGreaterThanOrEqual(44)
  }

  const start = sent.length
  await ctrl.tap()
  await expect(ctrl).toHaveAttribute('aria-pressed', 'true')
  await expect(ctrl).toHaveClass(/bg-primary/u)
  await key('Left').tap()
  await expect(ctrl, 'a modifier turns off once a key took it').toHaveAttribute('aria-pressed', 'false')
  await input.press('Backspace')
  await alt.tap()
  await input.press('b')
  await expect(alt).toHaveAttribute('aria-pressed', 'false')
  await expect(input, 'a letter sent as a control key leaves the line').toHaveValue('')
  await input.press('Backspace')
  await alt.tap()
  await input.press('Backspace')
  await ctrl.tap()
  await ctrl.tap()
  await expect(ctrl, 'a second tap turns a modifier off unused').toHaveAttribute('aria-pressed', 'false')
  await key('Pipe').scrollIntoViewIfNeeded()
  await key('Pipe').tap()
  await key('Page up').scrollIntoViewIfNeeded()
  await key('Page up').tap()
  await key('Shift+Tab').scrollIntoViewIfNeeded()
  await key('Shift+Tab').tap()
  await input.press('x')
  await expectSent(sent, start, ['\x1b[1;5D', '\x7f', '\x1bb', '\x7f', '\x1b\x7f', '|', '\x1b[5~', '\x1b[Z', 'x'])

  const held = sent.length
  const left = key('Left')
  await left.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true })
  await expect.poll(() => sent.slice(held).length).toBeGreaterThanOrEqual(3)
  await left.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true })
  expect(new Set(sent.slice(held))).toEqual(new Set(['\x1b[D']))
})

test('a key from the bar sends the word being composed first, then the key', async ({ page }) => {
  const sent = typedInput(page)
  const { keys, input } = await openTerminal(page)
  const board = new Gboard(page, await page.context().newCDPSession(page))

  const start = sent.length
  await board.type('ech')
  await keys.getByRole('button', { name: 'Tab', exact: true }).tap()
  await expectSent(sent, start, ['ech', '\t'])
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
})

for (const keyboard of ['Gboard', 'iOS'] as const) {
  test(`Ctrl then b then d detaches tmux as \\x02 then d, typed on ${keyboard}`, async ({ page }) => {
    const sent = typedInput(page)
    const { terminal, keys, input } = await openTerminal(page)
    const ctrl = keys.getByRole('button', { name: 'Control' })
    const tmux = tmuxPath()
    const server = `seti-e2e-${String(Date.now())}`
    if (tmux !== null) {
      await run(terminal, `${tmux} -L ${server} -f /dev/null new -s t`)
      await expect(screenOf(terminal)).toContainText('[t]')
    }
    const cdp = await page.context().newCDPSession(page)
    const board = new Gboard(page, cdp)
    const type = async (letter: string) =>
      keyboard === 'Gboard' ? board.letter(letter) : cdp.send('Input.insertText', { text: letter })

    const start = sent.length
    await ctrl.tap()
    await type('b')
    await expectSent(sent, start, ['\x02'])
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
    await type('d')
    await expectSent(sent, start, ['\x02', 'd'])
    if (tmux !== null) {
      await expect(screenOf(terminal)).toContainText('[detached')
    }
    if (keyboard === 'Gboard') {
      await board.enter()
      await expectSent(sent, start, ['\x02', 'd', '\r'])
      await expect(input).toHaveValue('')
    } else {
      await expect(input, 'the b went out as a control key, so only the d stays').toHaveValue('d')
      await input.press('Backspace')
      await expectSent(sent, start, ['\x02', 'd', '\x7f'])
    }
    if (tmux !== null) {
      await run(terminal, `${tmux} -L ${server} kill-server; echo gone-$((2+3))`)
      await expect(screenOf(terminal)).toContainText('gone-5')
    }
  })
}

test('a hardware keyboard on a phone sends Ctrl, Alt and arrow keys', async ({ page }) => {
  const sent = typedInput(page)
  const { terminal, input } = await openTerminal(page)
  await run(terminal, 'sleep 30 && echo late-$((2+2))')
  const start = sent.length
  await input.press('Control+c')
  await input.press('Alt+b')
  await input.press('ArrowUp')
  await input.press('Control+ArrowLeft')
  await expectSent(sent, start, ['\x03', '\x1bb', '\x1b[A', '\x1b[1;5D'])
  await input.press('Control+c')
  await run(terminal, 'echo hard-$((3+3))')
  await expect(screenOf(terminal)).toContainText('hard-6')
  await expect(screenOf(terminal)).not.toContainText('late-4')
})
