import type { Page } from '@playwright/test'
import { seedIdleAgent } from './support/agent-chrome.js'
import { seedCodexAgent } from './support/codex.js'
import { expect, test, unique } from './support/fixtures.js'

async function paletteAsk(page: Page) {
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill('>Ask aside')
  return palette.getByRole('option', { name: /Ask aside/ })
}

test("a mod's command shows only on an agent whose runtime offers what it needs", async ({ page }) => {
  const codex = await seedCodexAgent(unique('Codex needs'))
  await page.goto(`/#agents/${codex}`)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await expect(reply).toBeVisible()
  await expect(await paletteAsk(page)).toHaveCount(0)
  await page.keyboard.press('Escape')

  await reply.fill('/btw why this approach?')
  await expect(page.getByRole('status', { name: 'Composer status' })).toContainText('/btw is not on Codex')
  await reply.press('Enter')
  await expect(reply).toHaveValue('/btw why this approach?')
  await page.screenshot({ path: test.info().outputPath('mod-needs-codex.png') })

  const claude = await seedIdleAgent(unique('Claude needs'))
  await page.goto(`/#agents/${claude}`)
  await expect(await paletteAsk(page)).toHaveCount(1)
})
