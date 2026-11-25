import { openAgentSettings, showSection } from './support/agent-settings.js'
import { serveCodexServers } from './support/codex-servers.js'
import { seedCodexAgent } from './support/codex.js'
import { expect, test, unique } from './support/fixtures.js'

test("a Codex agent's settings say what its runtime lacks instead of offering controls that do nothing", async ({
  page,
}) => {
  const id = await seedCodexAgent(unique('Codex lacks'))
  await serveCodexServers(page, id)
  await page.goto(`/#agents/${id}`)
  const dialog = await openAgentSettings(page, 'Access')
  const access = await showSection(dialog, 'Access')
  const services = access.getByRole('list', { name: 'Access' })
  await expect(services).toContainText('AWS')
  await expect(services, 'a count of the servers the agent can use').toContainText('1 MCP')
  await expect(access.getByText('Sandboxed')).toBeVisible()
  await expect(access.getByRole('switch', { name: /sandbox/i })).toHaveCount(0)

  const session = await showSection(dialog, 'Session')
  await expect(session.getByText('Not on Codex')).toBeVisible()
  await expect(dialog.getByRole('group', { name: 'Dreams' })).toHaveCount(0)

  await showSection(dialog, 'Access')
  await access.getByRole('button', { name: 'Edit access' }).click()
  const edit = page.getByRole('dialog', { name: /Access of/ })
  const mcp = edit.getByRole('region', { name: 'MCP servers' })
  await expect(mcp).toContainText('1/1 on')
  await expect(mcp.getByRole('switch', { name: 'docs' })).toBeChecked()
  const events = mcp.getByRole('listitem').filter({ hasText: 'events' })
  await expect(events.getByRole('switch')).toHaveCount(0)
  await events.getByText('Not on Codex').hover()
  await expect(page.getByRole('tooltip')).toContainText('Codex agents cannot use SSE servers.')
  await expect(edit.getByRole('region', { name: 'Plugins' })).toContainText('Not on Codex')
})
