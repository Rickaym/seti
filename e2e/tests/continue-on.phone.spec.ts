import { openAgentSettings } from './support/agent-settings.js'
import { continueOnPicker, seedIdleCodexAgent } from './support/continue-on.js'
import { expect, test, toasts, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { transcript } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('continuing on another runtime fits a phone, from the cog to the transcript note', async ({ page }) => {
  const id = await seedIdleCodexAgent(unique('Move on a phone'))
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page)
  const picker = continueOnPicker(page)
  await picker.scrollIntoViewIfNeeded()
  await expect(picker).toBeInViewport()
  const box = await picker.boundingBox()
  expect(box?.height ?? 0, 'a 44 px touch target').toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'agent settings with Continue on')
  await picker.selectOption({ label: 'Default' })
  const dialog = page.getByRole('dialog', { name: 'Continue on Claude Code' })
  await expect(dialog).toContainText('The conversation stays here.')
  await expectFitsPhone(page, 'continue on confirmation')
  await dialog.getByRole('button', { name: 'Move', exact: true }).tap()
  await expect(toasts(page).filter({ hasText: 'Continues on Claude Code' })).toBeVisible()
  await expect(transcript(page)).toContainText('Continued on Claude Code')
})
