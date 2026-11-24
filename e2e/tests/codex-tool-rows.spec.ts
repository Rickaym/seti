import { seedCodexTranscript } from './support/codex-rows.js'
import { CODEX_ROWS } from './support/codex-tool-rows.js'
import { expect, test, unique } from './support/fixtures.js'

test('Codex commands show without their shell wrapper, and edits show the file and its diff', async ({ page }) => {
  const id = await seedCodexTranscript(unique('Codex rows'), 'tidy the notes', CODEX_ROWS)
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  const command = pane.locator('details').filter({ hasText: "sed -n '1,20p' notes.md" }).first()
  await expect(command.getByTestId('tool-summary')).toHaveText("sed -n '1,20p' notes.md")
  await expect(pane.getByText('zsh -lc')).toHaveCount(0)
  await command.locator('summary').click()
  await expect(command.getByText(/^cwd:/)).toHaveCount(0)

  const edit = pane
    .locator('details')
    .filter({ has: page.getByTestId('tool-summary').filter({ hasText: 'src/notes.md' }) })
  await expect(edit.getByTestId('tool-summary')).toHaveText('src/notes.md')
  await edit.locator('summary').click()
  await expect(edit.getByTestId('edit-change')).toContainText('+new line')
  await expect(edit.getByText('"move_path"')).toHaveCount(0)
})
