import { boxOf, LONG_RULE, seedIdleAgent, seedOwnRules, serveManyMcpServers } from './support/agent-chrome.js'
import { openAgentSettings, showSection } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('on a phone agent rules fit one line each and a long one unfolds with a tap', async ({ page, request }) => {
  const id = await seedIdleAgent(unique('E2E phone rules'))
  await seedOwnRules(request, id)
  await page.goto(`/#agents/${id}`)
  const details = await openAgentSettings(page, 'Access')
  const allow = details.getByRole('group', { name: 'Rules', exact: true }).getByRole('list', { name: 'Allow rules' })
  const long = allow.getByRole('listitem').filter({ hasText: 'gh pr view' })
  const short = allow.getByRole('listitem').filter({ hasText: /^Read$/ })
  const folded = (await long.locator('code').boundingBox())?.height ?? 0
  expect(folded).toBe((await short.locator('code').boundingBox())?.height ?? -1)
  await expectFitsPhone(page, 'agent rules')

  const toggle = long.getByRole('button', { name: LONG_RULE, exact: true })
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect((await long.locator('code').boundingBox())?.height ?? 0).toBeGreaterThan(folded)
  await expectFitsPhone(page, 'an unfolded rule')
})

test('on a phone the header leaves out the start notes and the agent settings keep them', async ({ page }) => {
  const id = await seedIdleAgent(unique('E2E phone setup'))
  const setup = {
    planner: 'fallback',
    fallback_reason: 'the planner timed out',
    repos: [],
    worktree: false,
    packs_linked: [],
    packs_unlinked: [],
    mcp_enabled: [],
    mcp_disabled: [],
    access: [],
    withheld: ['SSH gpu-box: not asked for explicitly'],
    ms: 1200,
  }
  const db = openSeedDb()
  await db.run('UPDATE task SET setup = ? WHERE id = ?', JSON.stringify(setup), id)
  await db.close()
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('button', { name: 'Agent settings' })).toBeVisible()
  await expect(main).not.toContainText('Not given')
  await expect(main).not.toContainText('Started with the defaults')

  const details = await openAgentSettings(page, 'Access')
  await expect(details.getByRole('list', { name: 'Held back' })).toHaveText('SSH gpu-box: not asked for explicitly')
  await showSection(details, 'Session')
  await expect(details.getByLabel('Planner', { exact: true })).toHaveText(
    'Started with the defaults: the planner timed out',
  )
  await expectFitsPhone(page, 'session settings')
})

test('on a phone the access dialog keeps one column and its bulk buttons', async ({ page }) => {
  const id = await seedIdleAgent(unique('E2E phone access'))
  const served = await serveManyMcpServers(page, id)
  await page.goto(`/#agents/${id}`)
  const details = await openAgentSettings(page, 'Access')
  await details.getByRole('button', { name: 'Edit access' }).tap()
  const dialog = page.getByRole('dialog', { name: /^Access of / })
  const list = dialog.getByRole('list', { name: 'MCP servers' })
  const servers = list.getByRole('listitem')
  await expect(servers).toHaveCount(11)
  const [first, second] = [await boxOf(servers, 0), await boxOf(servers, 1)]
  expect(second.x).toBe(first.x)
  expect(second.y).toBeGreaterThan(first.y)
  await expectFitsPhone(page, 'access dialog')

  await dialog.getByRole('button', { name: 'Select all MCP servers' }).tap()
  await expect(list.getByRole('switch', { checked: true })).toHaveCount(11)
  expect(served.puts()).toBe(8)
  await dialog.getByRole('button', { name: 'Clear all MCP servers' }).tap()
  await expect(list.getByRole('switch', { checked: false })).toHaveCount(11)
})

test('on a phone the agent access has no Gets rows and its credentials link opens the set', async ({ page }) => {
  const id = await seedIdleAgent(unique('E2E phone grants'))
  await page.goto(`/#agents/${id}`)
  const details = await openAgentSettings(page, 'Access')
  const access = details.getByRole('tabpanel', { name: 'Access' })
  await expect(access.locator('dt')).toHaveText(['Credentials', 'Can reach', 'Isolation', 'Bypass', 'Rules'])
  await expect(access.getByRole('list', { name: 'What this agent gets' })).toHaveCount(0)
  await expectFitsPhone(page, 'agent access')

  await access.getByRole('link', { name: 'Manage in Settings, Credentials' }).tap()
  await expect(page).toHaveURL(/#settings\/credentials\/default$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Default', level: 2 })).toBeVisible()
})
