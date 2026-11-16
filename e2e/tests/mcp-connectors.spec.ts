import type { McpServerInput } from '@seti/shared'
import { expect, test } from './support/fixtures.js'
import { mockSignInServers } from './support/mcp-sign-in.js'

test.use({ serverEnv: { SETI_MCP_REGISTRY_URL: 'http://127.0.0.1:9' } })

test('Add server lists common connectors and fills the add form from one', async ({ page }) => {
  await mockSignInServers(page)
  const added: McpServerInput[] = []
  await page.route('**/api/mcp/servers', async (route) => {
    added.push(route.request().postDataJSON() as McpServerInput)
    await route.fulfill({ json: { data: { name: 'gmail', scope: 'user' } } })
  })
  await page.goto('/#settings/mcp')
  await page.getByRole('main').getByRole('button', { name: 'Add MCP server' }).click()
  const catalog = page.getByRole('dialog', { name: 'Add MCP server' })
  const common = catalog.getByRole('region', { name: 'Common' })
  await expect(common.getByRole('button', { name: 'Supabase' })).toBeVisible()
  await expect(common.getByRole('button', { name: 'Slack' })).toContainText('slack@claude-plugins-official')

  await catalog.getByRole('textbox', { name: 'Search connectors' }).fill('gmail')
  await expect(catalog.getByRole('alert')).toContainText('The MCP Registry is unreachable')
  await expect(common.getByRole('button')).toHaveCount(1)
  await common.getByRole('button', { name: 'Gmail' }).click()

  const form = page.getByRole('dialog', { name: 'Add Gmail' })
  await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('gmail')
  await expect(form.getByRole('textbox', { name: 'URL' })).toHaveValue('https://gmailmcp.googleapis.com/mcp/v1')
  await expect(form.getByRole('textbox', { name: 'Callback port' })).toHaveValue('8765')
  await form.getByRole('textbox', { name: 'Client ID' }).fill('abc.apps.googleusercontent.com')
  await form.getByLabel('Client secret').fill('client-secret-value')
  await form.getByRole('button', { name: 'Add', exact: true }).click()
  await expect.poll(() => added.length).toBe(1)
  expect(added[0]).toMatchObject({
    name: 'gmail',
    transport: 'http',
    oauth: { client_id: 'abc.apps.googleusercontent.com', client_secret: 'client-secret-value', callback_port: 8765 },
  })
})

test('Custom server opens a blank form', async ({ page }) => {
  await mockSignInServers(page)
  await page.goto('/#settings/mcp')
  await page.getByRole('main').getByRole('button', { name: 'Add MCP server' }).click()
  await page.getByRole('dialog', { name: 'Add MCP server' }).getByRole('button', { name: 'Custom server' }).click()
  const form = page.getByRole('dialog', { name: 'Add MCP server' })
  await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('')
  await expect(form.getByRole('textbox', { name: 'Client ID' })).toBeHidden()
})
