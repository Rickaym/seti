import { boxOf, LONG_RULE, seedIdleAgent, seedOwnRules, serveManyMcpServers } from './support/agent-chrome.js'
import { openAgentSettings } from './support/agent-settings.js'
import { expect, test, toasts, unique } from './support/fixtures.js'

test('agent rules sit one line each, grouped as allow, ask and deny, and a long one unfolds', async ({
  page,
  request,
}) => {
  const id = await seedIdleAgent(unique('E2E rules'))
  await seedOwnRules(request, id)
  await page.goto(`/#agents/${id}`)
  const details = await openAgentSettings(page, 'Access')
  const rules = details.getByRole('group', { name: 'Rules', exact: true })
  await expect(rules.locator('h4')).toHaveText([/^Allow\s*2$/, /^Ask\s*1$/, /^Deny\s*1$/])
  await expect(rules.locator('.text-destructive')).toHaveCount(0)

  const allow = rules.getByRole('list', { name: 'Allow rules' })
  const long = allow.getByRole('listitem').filter({ hasText: 'gh pr view' })
  const short = allow.getByRole('listitem').filter({ hasText: /^Read$/ })
  const toggle = long.getByRole('button', { name: LONG_RULE, exact: true })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toHaveAttribute('title', LONG_RULE)
  const folded = (await long.locator('code').boundingBox())?.height ?? 0
  expect(folded).toBe((await short.locator('code').boundingBox())?.height ?? -1)
  await expect(long.getByRole('button', { name: `Remove allow rule ${LONG_RULE}` })).toBeVisible()

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect((await long.locator('code').boundingBox())?.height ?? 0).toBeGreaterThan(folded * 2)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

test('the access dialog lays MCP servers in two columns and turns a group all on or all off', async ({ page }) => {
  const id = await seedIdleAgent(unique('E2E access columns'))
  const served = await serveManyMcpServers(page, id)
  await page.goto(`/#agents/${id}`)
  const details = await openAgentSettings(page, 'Access')
  await details.getByRole('button', { name: 'Edit access' }).click()
  const dialog = page.getByRole('dialog', { name: /^Access of / })
  const list = dialog.getByRole('list', { name: 'MCP servers' })
  const servers = list.getByRole('listitem')
  await expect(servers).toHaveCount(11)

  const [first, second, third] = [await boxOf(servers, 0), await boxOf(servers, 1), await boxOf(servers, 2)]
  expect(Math.abs(second.y - first.y)).toBeLessThan(1)
  expect(second.x).toBeGreaterThanOrEqual(first.x + first.width - 1)
  expect(third.y).toBeGreaterThan(first.y)
  const viewport = page.viewportSize()
  expect((await dialog.boundingBox())?.height ?? Infinity).toBeLessThanOrEqual((viewport?.height ?? 0) * 0.85 + 1)

  const all = dialog.getByRole('button', { name: 'Select all MCP servers' })
  const clear = dialog.getByRole('button', { name: 'Clear all MCP servers' })
  await expect(all).toHaveText('All')
  await expect(clear).toHaveText('Clear')
  await all.click()
  await expect(list.getByRole('switch', { checked: true })).toHaveCount(11)
  await expect(all).toBeDisabled()
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
  expect(served.puts()).toBe(8)

  await clear.click()
  await expect(list.getByRole('switch', { checked: false })).toHaveCount(11)
  await expect(clear).toBeDisabled()
  await expect(all).toBeEnabled()
  expect(served.puts()).toBe(19)
})

test('the agent access keeps only its grants and links its credential to the Credentials page', async ({ page }) => {
  const id = await seedIdleAgent(unique('E2E access grants'))
  await page.goto(`/#agents/${id}`)
  const details = await openAgentSettings(page, 'Access')
  const access = details.getByRole('tabpanel', { name: 'Access' })
  await expect(access.locator('dt')).toHaveText(['Credentials', 'Services', 'Isolation', 'Bypass', 'Rules'])
  await expect(access.getByRole('list', { name: 'What this agent gets' })).toHaveCount(0)
  await expect(access).not.toContainText('own keys')

  await access.getByRole('button', { name: 'Edit access' }).click()
  const dialog = page.getByRole('dialog', { name: /^Access of / })
  const credentials = dialog.getByRole('region', { name: 'Credentials' })
  await expect(credentials.getByRole('link', { name: 'Manage in Settings, Credentials' })).toHaveText('Manage')
  await page.keyboard.press('Escape')

  const again = await openAgentSettings(page, 'Access')
  await again.getByRole('link', { name: 'Manage in Settings, Credentials' }).click()
  await expect(page).toHaveURL(/#settings\/credentials\/default$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Default', level: 2 })).toBeVisible()
})
