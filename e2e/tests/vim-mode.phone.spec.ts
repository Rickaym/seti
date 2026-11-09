import { expect, test, unique } from './support/fixtures.js'
import { modToggle, setModEnabled } from './support/mods.js'
import { tapMoreAction } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, startIdleAgent, terminalIn, terminalInput, typedInput } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test.afterEach(async ({ request }) => {
  await setModEnabled(request, 'vim', false)
})

test('the phone turns Vim mode on in Settings, Mods, and takes no Vim keys or status item', async ({ page }) => {
  await page.goto('/#settings/mods')
  const toggle = modToggle(page, 'Vim mode')
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expectFitsPhone(page, 'mods settings with Vim mode on')

  await page.goto('/#agents')
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  for (const key of ['j', 'k', 'G', '?', 'Escape']) {
    await page.keyboard.press(key)
  }
  await expect(page.getByRole('dialog', { name: 'Vim mode keys' })).toHaveCount(0)
  await expect(page.getByTestId('vim-mode')).toHaveCount(0)
  await expect(page.locator('[data-panel-active]')).toHaveCount(0)

  await page.goto('/#settings/mods')
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

test('with Vim mode on, a phone terminal still sends Ctrl+\\ to its shell', async ({ page, request }) => {
  const id = await startIdleAgent(request, unique('Phone Vim shell'))
  await setModEnabled(request, 'vim', true)
  const sent = typedInput(page)
  await page.goto(`/#agents/${id}`)
  await tapMoreAction(page, 'Terminal')
  const terminal = terminalIn(page)
  await run(terminal, 'sleep 30; echo woke-$((2+3))')
  await expect(screenOf(terminal)).toContainText('sleep 30; echo woke-')
  const mark = sent.length
  await terminalInput(terminal).press('Control+Backslash')
  await expect(screenOf(terminal)).toContainText('woke-5')
  expect(sent.slice(mark).join('')).toBe('\x1c')
  await expect(page.getByTestId('vim-mode')).toHaveCount(0)
  await expectFitsPhone(page, 'terminal with Vim mode on')
})
