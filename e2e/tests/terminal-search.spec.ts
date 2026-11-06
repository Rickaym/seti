import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, terminalButton, terminalIn } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('Ctrl+Shift+F finds output that scrolled away, steps between matches and hands focus back', async ({ page }) => {
  await page.goto('/#settings')
  await terminalButton(page).click()
  const terminal = terminalIn(page)
  await run(terminal, 'echo needle-$((2*3)); echo needle-$((2*3)); seq 1 300')
  await expect(screenOf(terminal)).toContainText('300')
  await expect(screenOf(terminal)).not.toContainText('needle-6')
  const input = terminal.locator('.xterm-helper-textarea')

  await input.press('Control+Shift+F')
  const find = terminal.getByRole('searchbox', { name: 'Find in terminal' })
  await expect(find).toBeFocused()
  await find.fill('needle-6')
  const count = terminal.getByRole('search').getByRole('status')
  await expect(count).toHaveText(/^[12] of 2$/u)
  await expect(screenOf(terminal)).toContainText('needle-6')
  const first = await count.innerText()
  await find.press('Enter')
  await expect(count).not.toHaveText(first)
  await expect(count).toHaveText(/^[12] of 2$/u)
  await find.fill('haystack')
  await expect(count).toHaveText('No matches')

  await find.press('Escape')
  await expect(terminal.getByRole('search')).toHaveCount(0)
  await expect(input).toBeFocused()
  await terminal.getByRole('button', { name: 'Find in terminal output' }).click()
  await expect(find).toBeFocused()
  await terminal.getByRole('button', { name: 'Close find' }).click()
  await expect(terminal.getByRole('search')).toHaveCount(0)
})
