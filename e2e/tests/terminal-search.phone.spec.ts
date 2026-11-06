import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, terminalIn } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('the find button searches the output on a phone', async ({ page }) => {
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  const terminal = terminalIn(page)
  await run(terminal, 'echo needle-$((3*3)); seq 1 300')
  await expect(screenOf(terminal)).toContainText('300')

  await terminal.getByRole('button', { name: 'Find in terminal output' }).tap()
  const find = terminal.getByRole('searchbox', { name: 'Find in terminal' })
  await find.fill('needle-9')
  await expect(terminal.getByRole('search').getByRole('status')).toHaveText('1 of 1')
  await expect(screenOf(terminal)).toContainText('needle-9')
  await expectFitsPhone(page, 'terminal find')
  await terminal.getByRole('button', { name: 'Close find' }).tap()
  await expect(terminal.getByRole('search')).toHaveCount(0)
})
