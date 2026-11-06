import { expect, test } from './support/fixtures.js'
import { mockSignInServers, serverRow } from './support/mcp-sign-in.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('a phone offers the sign-in to a connected server without a token', async ({ page }) => {
  await mockSignInServers(page)
  await page.goto('/#settings/mcp')
  const signIn = serverRow(page, 'tracker').getByRole('button', { name: 'Sign in', exact: true })
  await expect(signIn).toBeVisible()
  await expect(serverRow(page, 'wiki').getByRole('button', { name: 'Sign in to wiki again' })).toBeVisible()
  await expectFitsPhone(page, 'MCP sign-in')
  await signIn.click()
  await expect(page.getByRole('dialog', { name: 'Sign in to tracker' })).toBeVisible()
})
