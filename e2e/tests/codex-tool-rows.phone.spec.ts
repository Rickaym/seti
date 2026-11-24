import { seedCodexTranscript } from './support/codex-rows.js'
import { CODEX_ROWS } from './support/codex-tool-rows.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test("a Codex agent's command and edit rows fit a phone, closed and open", async ({ page }) => {
  const id = await seedCodexTranscript(unique('Phone rows'), 'tidy the notes', CODEX_ROWS)
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  await expect(pane.getByText("sed -n '1,20p' notes.md").first()).toBeVisible()
  await expectFitsPhone(page, 'Codex tool rows')
  const edit = pane
    .locator('details')
    .filter({ has: page.getByTestId('tool-summary').filter({ hasText: 'src/notes.md' }) })
  await edit.locator('summary').tap()
  await expect(edit.getByTestId('edit-change')).toBeVisible()
  await expectFitsPhone(page, 'an open Codex edit')
})
