import { expect, test } from './support/fixtures.js'
import { mockSignInServers } from './support/mcp-sign-in.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('a phone picks a common connector and reads its add form', async ({ page }) => {
  await mockSignInServers(page)
  await page.goto('/#settings/mcp')
  await page.getByRole('main').getByRole('button', { name: 'Add MCP server' }).click()
  const catalog = page.getByRole('dialog', { name: 'Add MCP server' })
  await expect(catalog.getByRole('button', { name: 'Notion' })).toBeVisible()
  await expectFitsPhone(page, 'connector catalog')
  await catalog.getByRole('button', { name: 'Notion' }).click()
  const form = page.getByRole('dialog', { name: 'Add Notion' })
  await expect(form.getByRole('textbox', { name: 'URL' })).toHaveValue('https://mcp.notion.com/mcp')
  await expectFitsPhone(page, 'Notion add form')
})
