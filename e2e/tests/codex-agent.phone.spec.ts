import { CODEX_COMMAND, seedCodexAgent } from './support/codex.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test("a phone shows a Codex agent's request with Allow and Deny only", async ({ page }) => {
  const id = await seedCodexAgent(unique('Codex phone'))
  await page.goto(`/#agents/${id}`)
  const card = page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })
  await expect(card).toContainText(CODEX_COMMAND)
  await expect(card.getByRole('button', { name: 'Always' })).toHaveCount(0)
  await expect(card.getByPlaceholder('Note if you deny (optional)'), 'Codex cannot pass a note on').toHaveCount(0)
  await expectFitsPhone(page, "a Codex agent's permission request")
  await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeInViewport()
  await expect(card.getByRole('button', { name: 'Deny' })).toBeInViewport()
  const reply = page.getByRole('main').locator('textarea[placeholder*="shell"]')
  await expect(reply).toBeVisible()
  await expect(reply, "a Codex agent takes Seti's setting commands").toHaveAttribute(
    'placeholder',
    /\/ (for a )?command/,
  )
})
