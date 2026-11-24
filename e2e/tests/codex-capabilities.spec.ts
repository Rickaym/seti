import { openAgentSettings, showSection } from './support/agent-settings.js'
import { seedCodexAgent } from './support/codex.js'
import { expect, test, unique } from './support/fixtures.js'

test("a Codex agent's settings say what its runtime lacks instead of offering controls that do nothing", async ({
  page,
}) => {
  const id = await seedCodexAgent(unique('Codex lacks'))
  await page.goto(`/#agents/${id}`)
  const dialog = await openAgentSettings(page, 'Access')
  const access = await showSection(dialog, 'Access')
  const services = access.getByRole('list', { name: 'Access' })
  await expect(services).toContainText('AWS')
  await expect(services, 'no count of servers the agent never gets').not.toContainText('MCP')
  await expect(access.getByText('Sandboxed')).toBeVisible()
  await expect(access.getByRole('switch', { name: /sandbox/i })).toHaveCount(0)

  const session = await showSection(dialog, 'Session')
  await expect(session.getByText('Not on Codex')).toBeVisible()
  await expect(dialog.getByRole('group', { name: 'Dreams' })).toHaveCount(0)

  await showSection(dialog, 'Access')
  await access.getByRole('button', { name: 'Edit access' }).click()
  const edit = page.getByRole('dialog', { name: /Access of/ })
  const mcp = edit.getByRole('region', { name: 'MCP servers' })
  await expect(mcp).toContainText('Not on Codex')
  await expect(mcp.getByRole('switch')).toHaveCount(0)
  await expect(edit.getByRole('region', { name: 'Plugins' })).toContainText('Not on Codex')
})
