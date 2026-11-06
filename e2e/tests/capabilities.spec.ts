import { randomUUID } from 'node:crypto'
import type { AccessItem, ApiError, McpAuthStart, McpSignInInput, TaskAccessView } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'
import { mockSignInServers, serverRow } from './support/mcp-sign-in.js'

const PROBE_TIMEOUT_MS = 60_000
const PROBING = /Starting Claude Code and waiting for MCP servers/

test.use({ allowedHttpStatuses: [500] })

test('renders the probe result without a Claude login', async ({ page, request }) => {
  test.setTimeout(PROBE_TIMEOUT_MS * 2)
  const probe = await request.get('/api/capabilities', { timeout: PROBE_TIMEOUT_MS })
  await page.goto('/#settings/mcp')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'MCP servers', level: 2 })).toBeVisible()
  await expect(main.getByText(PROBING)).toBeHidden({ timeout: PROBE_TIMEOUT_MS })
  if (probe.ok()) {
    await expect(main.getByText('No MCP servers configured.')).toBeVisible()
    await expect(main.getByLabel('Search mcp servers')).toBeVisible()
  } else {
    const body = (await probe.json()) as ApiError
    await expect(main.getByText(body.error.detail)).toBeVisible()
  }
})

test('shows the error when the probe cannot run', async ({ page }) => {
  const detail = 'Claude Code could not start: not logged in'
  await page.route(/\/api\/capabilities(\/refresh)?(\?.*)?$/, async (route) =>
    route.fulfill({ status: 500, json: { error: { title: 'Server error', detail } } satisfies ApiError }),
  )
  await page.goto('/#settings/skills')
  const main = page.getByRole('main')
  await expect(main.getByText(detail)).toBeVisible()
  await expect(main.getByText(PROBING)).toBeHidden()
  await expect(main.getByLabel('Search mcp servers')).toBeHidden()

  await main.getByRole('button', { name: 'Refresh' }).click()
  await expect(main.getByText(detail)).toBeVisible()
  await expect(main.getByRole('button', { name: 'Refresh' })).toBeEnabled()
})

test('offers a sign-in to a connected server whose client ID has no token yet', async ({ page }) => {
  await mockSignInServers(page)
  await page.goto('/#settings/mcp')
  const tracker = serverRow(page, 'tracker')
  await expect(tracker.getByText('needs auth')).toBeVisible()
  await expect(tracker.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()

  const wiki = serverRow(page, 'wiki')
  await expect(wiki.getByText('connected')).toBeVisible()
  await expect(wiki.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
  await expect(serverRow(page, 'search').getByRole('button', { name: /^Sign in/ })).toHaveCount(0)

  await wiki.getByRole('button', { name: 'Sign in to wiki again' }).click()
  await expect(page.getByRole('dialog', { name: 'Sign in to wiki' })).toBeVisible()
})

/** The agent's session reports search as needing auth, although the host probe has it connected. */
const agentSearch: AccessItem = {
  kind: 'mcp',
  id: 'search',
  name: 'search',
  detail: 'configured',
  default_enabled: true,
  override: null,
  enabled: true,
  jump_for: [],
  missing_key: [],
  in_set: false,
  session: { status: 'needs-auth', reason: 'Not signed in.', sign_in: 'required', at: '2026-10-08T07:17:35.000Z' },
}

test("signs in from an agent's access when its session needs auth and the host probe is connected", async ({
  page,
  request,
}) => {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, `E2E agent sign-in ${id.slice(0, 6)}`, paths.checkout, new Date().toISOString())
  await db.close()
  await mockSignInServers(page)
  await page.route(`**/api/tasks/${id}/access`, async (route) => {
    const real = (await (await route.fetch()).json()) as { data: TaskAccessView }
    const items = [...real.data.items.filter((item) => item.kind !== 'mcp'), agentSearch]
    await route.fulfill({ json: { ...real, data: { ...real.data, items } } })
  })
  const starts: McpSignInInput[] = []
  const started: McpAuthStart = {
    session_id: 'e2e-agent-sign-in',
    authorization_url: 'https://auth.example.com/authorize',
    callback_expected: true,
  }
  await page.route(/\/api\/mcp\/search\/auth\/start$/, async (route) => {
    starts.push(route.request().postDataJSON() as McpSignInInput)
    await route.fulfill({ json: { data: started, meta: {} } })
  })
  await page.route(/\/api\/mcp\/auth\/e2e-agent-sign-in$/, async (route) => route.fulfill({ status: 204 }))

  await page.goto('/#settings/mcp')
  await expect(serverRow(page, 'search').getByText('connected')).toBeVisible()
  await expect(serverRow(page, 'search').getByRole('button', { name: /^Sign in/ })).toHaveCount(0)

  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Access')
  await page.getByRole('button', { name: 'Edit access' }).click()
  const access = page.getByRole('dialog', { name: /^Access of / })
  const row = access.getByRole('region', { name: 'MCP servers' }).getByRole('listitem').filter({ hasText: 'search' })
  await expect(row.getByLabel('Latest session: needs auth')).toBeVisible()
  await row.getByRole('button', { name: 'Sign in', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign in to search' })
  await expect(dialog.getByText('1. Approve access')).toBeVisible()
  expect(starts).toEqual([{ task_id: id }])
  await page.keyboard.press('Escape')
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
