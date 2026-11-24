import { randomUUID } from 'node:crypto'
import { openAgentSettings, showSection } from './support/agent-settings.js'
import { CODEX_COMMAND, seedCodexAgent } from './support/codex.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test, unique } from './support/fixtures.js'

test("a Codex agent's request offers Allow and Deny only, and its settings say what it lacks", async ({ page }) => {
  const db = openSeedDb()
  await db.idleTask(randomUUID(), unique('Claude beside it'), paths.checkout, new Date().toISOString())
  await db.close()
  const id = await seedCodexAgent(unique('Codex tests'))
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const card = main.getByRole('region', { name: 'Permission request for Bash' })
  await expect(card).toContainText(CODEX_COMMAND)
  await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Always' })).toHaveCount(0)
  await expect(card.getByPlaceholder('Note if you deny (optional)'), 'Codex cannot pass a note on').toHaveCount(0)
  await expect(main.getByRole('img', { name: 'Codex, gpt-5.5' }).first(), 'shown while runtimes mix').toBeVisible()

  const reply = main.locator('textarea[placeholder*="! to run a shell command"]')
  await expect(reply).toBeVisible()
  await expect(reply, 'a Codex agent takes no slash commands').not.toHaveAttribute('placeholder', /\//)
  await expect(main.locator('textarea[placeholder*="Esc Esc"]'), 'a Codex agent cannot rewind').toHaveCount(0)

  const dialog = await openAgentSettings(page, 'Access')
  await expect(dialog.getByTestId('bypass')).toHaveCount(0)
  await expect(dialog.getByTestId('bypass')).toHaveCount(0)
  await expect(dialog.getByText('Not on Codex').first()).toBeVisible()
  const session = await showSection(dialog, 'Session')
  await expect(session).toContainText('Codex, high')
  await expect(session).toContainText(/Estimated from OpenAI prices as of \d{4}-\d{2}-\d{2}/)
})
