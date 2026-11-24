import { commandStarted, seedCodexTranscript, turnEnded, turnStarted } from './support/codex-rows.js'
import { expect, test, unique } from './support/fixtures.js'

test('a Codex call that a stop cut before it ran reads as stopped, not running or failed', async ({ page }) => {
  const id = await seedCodexTranscript(unique('Codex stopped'), 'read the tests', [
    turnStarted,
    commandStarted('call-held', 'git log -1'),
    turnEnded('interrupted', ['call-held']),
  ])
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  const call = pane.locator('details').filter({ hasText: 'git log -1' })
  await expect(call.getByTestId('tool-stopped')).toHaveText('stopped')
  await expect(call.getByTestId('tool-running')).toHaveCount(0)
  await expect(call.getByTestId('tool-failed')).toHaveCount(0)
})
