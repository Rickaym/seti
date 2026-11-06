import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, screenRows, shellRows, terminalButton, terminalIn } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('Ctrl+= and Ctrl+- size the terminal font, the shell follows, and the size outlasts a reload', async ({
  page,
}) => {
  await page.goto('/#settings')
  await terminalButton(page).click()
  const terminal = terminalIn(page)
  await run(terminal, 'echo ready-$((1+1))')
  await expect(screenOf(terminal)).toContainText('ready-2')
  const resting = await shellRows(terminal)
  const input = terminal.locator('.xterm-helper-textarea')

  for (let step = 0; step < 4; step++) {
    await input.press('Control+Equal')
  }
  await expect.poll(async () => (await screenRows(terminal)).drawn).toBeLessThan(resting - 3)
  const grown = await shellRows(terminal)
  expect(grown, 'the shell hears the new size').toBe((await screenRows(terminal)).drawn)
  await expect(screenOf(terminal)).toContainText('ready-2')

  await page.reload()
  await expect(screenOf(terminal)).toContainText('ready-2')
  await expect.poll(async () => shellRows(terminal)).toBe(grown)

  await input.press('Control+Minus')
  await expect.poll(async () => (await screenRows(terminal)).drawn).toBeGreaterThan(grown)
  await input.press('Control+Digit0')
  await expect.poll(async () => shellRows(terminal)).toBe(resting)
})
