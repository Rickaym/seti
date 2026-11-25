import { openAgentSettings, showSection } from './support/agent-settings.js'
import { serveCodexServers } from './support/codex-servers.js'
import { seedCodexAgent } from './support/codex.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test("a phone shows what a Codex agent's runtime lacks in its settings and access", async ({ page }) => {
  const id = await seedCodexAgent(unique('Codex lacks phone'))
  await serveCodexServers(page, id)
  await page.goto(`/#agents/${id}`)
  const dialog = await openAgentSettings(page, 'Access')
  const access = await showSection(dialog, 'Access')
  await expect(access.getByText('Sandboxed')).toBeVisible()
  await expectFitsPhone(page, "a Codex agent's access section")
  const session = await showSection(dialog, 'Session')
  await expect(session.getByText('Not on Codex')).toBeVisible()
  await showSection(dialog, 'Access')
  await access.getByRole('button', { name: 'Edit access' }).tap()
  const edit = page.getByRole('dialog', { name: /Access of/ })
  const mcp = edit.getByRole('region', { name: 'MCP servers' })
  await expect(mcp.getByRole('listitem').filter({ hasText: 'events' })).toContainText('Not on Codex')
  await expect(mcp.getByRole('switch', { name: 'docs' })).toBeVisible()
  await expect(edit.getByRole('region', { name: 'Plugins' })).toContainText('Not on Codex')
  await expectFitsPhone(page, "a Codex agent's access dialog")
})
