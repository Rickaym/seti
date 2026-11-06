import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { Gboard } from './support/gboard.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { screenOf, terminalIn, terminalInput, typedInput } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

/** Opens a terminal alone, taps its screen and returns it with Gboard typing into its line. */
async function openTyping(page: Page): Promise<{ terminal: Locator; line: Locator; board: Gboard }> {
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  const terminal = terminalIn(page)
  await expect(terminal.getByText('Connecting...')).toHaveCount(0)
  await expect(screenOf(terminal)).toContainText('$ ')
  await terminal.locator('.xterm-screen').tap()
  const line = terminalInput(terminal)
  await expect(line, 'a tap on the screen brings the keyboard up for the line').toBeFocused()
  expect(await line.evaluate((el) => el.tagName), 'Chrome shows no autofill bar over a textarea').toBe('TEXTAREA')
  const cdp = await page.context().newCDPSession(page)
  return { terminal, line, board: new Gboard(page, cdp) }
}

/** Waits until the shell got exactly `expected` since `from`, as separate input messages. */
async function expectSent(sent: string[], from: number, expected: string[]): Promise<void> {
  await expect.poll(() => sent.slice(from)).toEqual(expected)
}

test('Gboard typing reaches the shell once, word by word, in order', async ({ page }) => {
  const sent = typedInput(page)
  const { terminal, line, board } = await openTyping(page)
  const start = sent.length

  await board.type('echo Thank you a few things, the set header ')
  await expect(line).toHaveValue('echo Thank you a few things, the set header ')
  await board.enter()

  const words = ['echo', 'Thank', 'you', 'a', 'few', 'things,', 'the', 'set', 'header']
  await expectSent(sent, start, [...words.flatMap((word) => [word, ' ']), '\r'])
  await expect(line).toHaveValue('')
  await expect(screenOf(terminal)).toContainText(/\$ echo Thank you a few things, the set header\s*Thank you a few/u)
})

test('autocorrect, an earlier word corrected, a swipe and dictation each land once', async ({ page }) => {
  const sent = typedInput(page)
  const { terminal, line, board } = await openTyping(page)
  const start = sent.length

  await board.type('echo waether travker ', { waether: 'weather' })
  await expectSent(sent, start, ['echo', ' ', 'weather', ' ', 'travker', ' '])

  const fixed = sent.length
  await line.evaluate((field: HTMLInputElement) => {
    const at = field.value.indexOf('travker')
    field.setRangeText('tracker', at, at + 'travker'.length, 'end')
    field.setSelectionRange(field.value.length, field.value.length)
    field.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText', data: 'tracker', bubbles: true }))
  })
  await expectSent(sent, fixed, ['\x7f\x7f\x7f\x7f\x7fcker '])

  const rest = sent.length
  await board.swipe('then')
  await board.dictate(['set', 'set the', 'set the header'])
  await board.enter()
  await expectSent(sent, rest, ['then', ' ', 'set the header', ' ', '\r'])
  await expect(screenOf(terminal)).toContainText(/\$ echo weather tracker then set the header\s*weather tracker then/u)
})

for (const how of ['text', 'insertLineBreak', 'insertParagraph'] as const) {
  test(`Enter sent as ${how} goes out as Return and leaves no newline in the line`, async ({ page }) => {
    const sent = typedInput(page)
    const { terminal, line, board } = await openTyping(page)
    const start = sent.length

    await board.type('echo one ')
    await board.enter(how)
    await expectSent(sent, start, ['echo', ' ', 'one', ' ', '\r'])
    await expect(line).toHaveValue('')
    await board.type('echo two')
    await board.enter(how)
    await expectSent(sent, start, ['echo', ' ', 'one', ' ', '\r', 'echo', ' ', 'two', '\r'])
    await expect(line).toHaveValue('')
    await expect(screenOf(terminal)).toContainText(/\$ echo two\s*two/u)
  })
}

test('Backspace edits the composing word, the line, and then the shell itself', async ({ page }) => {
  const sent = typedInput(page)
  const { line, board } = await openTyping(page)
  const start = sent.length

  await board.type('lx')
  await board.backspace()
  await board.type('s ')
  await expectSent(sent, start, ['ls', ' '])
  await board.backspace()
  await board.backspace()
  await expectSent(sent, start, ['ls', ' ', '\x7f', '\x7f'])
  await board.letter('x')
  await board.backspace()
  await board.backspace()
  await expect(line).toHaveValue('')
  await board.backspace()
  await expectSent(sent, start, ['ls', ' ', '\x7f', '\x7f', '\x7f', '\x7f'])
})
