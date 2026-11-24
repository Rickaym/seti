import { commandStarted, seedCodexTranscript, turnEnded, turnStarted } from './support/codex-rows.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('a stopped Codex call fits a phone, closed and open', async ({ page }) => {
  const id = await seedCodexTranscript(unique('Phone stopped'), 'read the tests', [
    turnStarted,
    commandStarted('call-held', 'git log -1'),
    turnEnded('interrupted', ['call-held']),
  ])
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  const call = pane.locator('details').filter({ hasText: 'git log -1' })
  await expect(call.getByTestId('tool-stopped')).toBeVisible()
  await expectFitsPhone(page, 'a stopped call')
  await call.locator('summary').tap()
  await expect(call.getByRole('button', { name: 'Copy command' })).toBeVisible()
  await expectFitsPhone(page, 'a stopped call, open')
})
