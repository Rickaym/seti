import { seedIdleAgent } from './support/agent-chrome.js'
import { seedCodexAgent } from './support/codex.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test("a phone's agent actions leave out a mod's command the agent's runtime cannot run", async ({ page }) => {
  const codex = await seedCodexAgent(unique('Codex needs phone'))
  await page.goto(`/#agents/${codex}`)
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'More actions' }).tap()
  const sheet = page.getByRole('dialog', { name: 'Agent actions' })
  await expect(sheet.getByRole('button', { name: 'Find in this chat' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: /Ask aside/ })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('mod-needs-codex-actions-phone.png') })
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.tap()
  await reply.fill('/btw why this approach?')
  await expect(page.getByRole('status', { name: 'Composer status' })).toContainText('/btw is not on Codex')
  await expectFitsPhone(page, 'a refused /btw on a Codex agent')
  await page.screenshot({ path: test.info().outputPath('mod-needs-codex-btw-phone.png') })

  const claude = await seedIdleAgent(unique('Claude needs phone'))
  await page.goto(`/#agents/${claude}`)
  await main.getByRole('button', { name: 'More actions' }).tap()
  await expect(
    page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: /Ask aside/ }),
  ).toBeVisible()
})
