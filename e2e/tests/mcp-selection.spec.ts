import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import type { AuditPage, McpSelectionEntry, TaskMcpServer } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'

const PROBE_TIMEOUT_MS = 60_000
const PROBING = /Starting Claude Code and waiting for MCP servers/
const SERVER = 'e2e-docs'

async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, sandbox, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 1, 'idle', ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  await db.close()
  return id
}

/** A session start of the task, listing the MCP servers it had as Claude Code reports them. */
async function seedSessionStart(taskId: string, servers: { name: string; status: string }[]): Promise<void> {
  const db = openSeedDb()
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: 'claude-e2e',
    permissionMode: 'bypassPermissions',
    cwd: paths.checkout,
    tools: [],
    plugins: [],
    mcp_servers: servers,
  }
  await db.message(taskId, 'sdk', JSON.stringify(init), new Date().toISOString())
  await db.close()
}

test('an MCP server off by default, turned on by the planner and in agent details', async ({ page, request }) => {
  test.setTimeout(PROBE_TIMEOUT_MS * 4)
  const added = await request.post('/api/mcp/servers', {
    data: { name: SERVER, scope: 'user', transport: 'http', url: 'http://127.0.0.1:9/mcp' },
  })
  expect(added.ok()).toBe(true)
  const id = await seedTask(`E2E mcp ${randomUUID().slice(0, 8)}`)
  try {
    await request.post('/api/capabilities/refresh', { data: {}, timeout: PROBE_TIMEOUT_MS })
    await page.goto('/#settings/mcp')
    const main = page.getByRole('main')
    await expect(main.getByText(PROBING)).toBeHidden({ timeout: PROBE_TIMEOUT_MS })
    const byDefault = main.getByRole('switch', { name: `${SERVER} on by default` })
    await expect(byDefault).toBeChecked()
    await byDefault.click()
    await expect(toasts(page).filter({ hasText: `${SERVER} is off by default` })).toBeVisible()
    await expect(byDefault).not.toBeChecked()
    const selection = await apiData<McpSelectionEntry[]>(request, '/mcp/selection')
    expect(selection.find((entry) => entry.name === SERVER)).toMatchObject({ default_enabled: false, known: true })

    await page.goto('/#agents/new')
    await page.getByLabel('Message').fill(`Look up the release notes with ${SERVER}`)
    await page.getByLabel('Message').press('Enter')
    await expect(page).toHaveURL(/#agents\/[\da-f-]{36}$/)
    const planned = new URL(page.url()).hash.split('/')[1] ?? ''
    const mcpChip = page.getByRole('list', { name: 'Access' }).getByRole('listitem').filter({ hasText: 'MCP' })
    await openAgentSettings(page, 'Access')
    await expect(mcpChip).toHaveText('1 MCP')
    await page.keyboard.press('Escape')
    await expect(main).not.toContainText('Not given')
    const chosen = await apiData<TaskMcpServer[]>(request, `/tasks/${planned}/mcp`)
    expect(chosen.find((s) => s.name === SERVER)).toMatchObject({ enabled: true, choice: true })
    await page.goto('/#agents')
    expect((await request.delete(`/api/tasks/${planned}`)).ok()).toBe(true)

    await page.goto(`/#agents/${id}`)
    await openAgentSettings(page, 'Access')
    const change = page.getByRole('button', { name: 'Edit access' })
    await expect(mcpChip).toHaveText('MCP')
    await expect(mcpChip.locator('[data-on]')).toHaveAttribute('data-on', 'false')
    await change.click()
    const access = page.getByRole('dialog', { name: /^Access of / })
    const server = access.getByRole('region', { name: 'MCP servers' }).getByRole('switch', { name: SERVER })
    await expect(server).not.toBeChecked()
    await server.click()
    await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
    await expect(server).toBeChecked()
    await page.keyboard.press('Escape')
    await openAgentSettings(page, 'Access')
    await expect(mcpChip).toHaveText('1 MCP')
    const servers = await apiData<TaskMcpServer[]>(request, `/tasks/${id}/mcp`)
    expect(servers.find((s) => s.name === SERVER)).toMatchObject({ enabled: true, choice: true })

    await seedSessionStart(id, [{ name: SERVER, status: 'failed' }])
    await page.reload()
    await openAgentSettings(page, 'Access')
    await expect(mcpChip.locator('[data-on]')).toHaveAttribute('data-on', 'false')
    await change.click()
    const row = access.getByRole('region', { name: 'MCP servers' }).getByRole('listitem').filter({ hasText: SERVER })
    await expect(row.getByLabel('Latest session: failed')).toBeVisible()
    await expect(row).toContainText('It failed to start or connect.')
    await page.keyboard.press('Escape')

    await seedSessionStart(id, [])
    await page.reload()
    await openAgentSettings(page, 'Access')
    await change.click()
    await expect(row.getByLabel('Latest session: not loaded')).toBeVisible()
  } finally {
    await request.put(`/api/mcp/defaults/${SERVER}`, { data: { enabled: true } })
    await request.delete(`/api/mcp/servers/${SERVER}?scope=user`)
    await request.post('/api/capabilities/refresh', { data: {}, timeout: PROBE_TIMEOUT_MS })
  }
})

test('a local MCP server of another directory is off for other agents until turned on', async ({ page, request }) => {
  test.setTimeout(PROBE_TIMEOUT_MS * 4)
  const local = 'e2e-home-local'
  const added = await request.post('/api/mcp/servers', {
    data: { name: local, scope: 'local', transport: 'http', url: 'http://127.0.0.1:9/mcp' },
  })
  expect(added.ok()).toBe(true)
  const id = await seedTask(`E2E local mcp ${randomUUID().slice(0, 8)}`)
  try {
    await request.post('/api/capabilities/refresh', { data: {}, timeout: PROBE_TIMEOUT_MS })
    const selection = await apiData<McpSelectionEntry[]>(request, '/mcp/selection')
    expect(selection.find((entry) => entry.name === local)).toMatchObject({ default_enabled: false, local_to: ['~'] })
    await page.goto('/#settings/mcp')
    const main = page.getByRole('main')
    await expect(main.getByText(PROBING)).toBeHidden({ timeout: PROBE_TIMEOUT_MS })
    await expect(main.getByRole('switch', { name: `${local} on by default` })).not.toBeChecked()
    await expect(main.getByText('From ~; off unless turned on')).toBeVisible()

    await page.goto(`/#agents/${id}`)
    await openAgentSettings(page, 'Access')
    await page.getByRole('button', { name: 'Edit access' }).click()
    const access = page.getByRole('dialog', { name: /^Access of / })
    const servers = access.getByRole('region', { name: 'MCP servers' })
    await expect(servers.getByRole('listitem').filter({ hasText: local })).toContainText('From ~; off unless turned on')
    const server = servers.getByRole('switch', { name: local })
    await expect(server).not.toBeChecked()
    await server.click()
    await expect(server).toBeChecked()
    const chosen = await apiData<TaskMcpServer[]>(request, `/tasks/${id}/mcp`)
    expect(chosen.find((s) => s.name === local)).toMatchObject({ enabled: true, choice: true, borrowed: true })
  } finally {
    await request.delete(`/api/mcp/servers/${local}?scope=local`)
    await request.post('/api/capabilities/refresh', { data: {}, timeout: PROBE_TIMEOUT_MS })
  }
})

const GONE = 'e2e-gone'
const GONE_SERVER = { name: GONE, scope: 'user', transport: 'http', url: 'http://127.0.0.1:9/mcp' }

/** Adds the server, turns it off by default and on for a new agent, as a user would. */
async function chooseServer(request: APIRequestContext): Promise<string> {
  expect((await request.post('/api/mcp/servers', { data: GONE_SERVER })).ok()).toBe(true)
  await request.post('/api/capabilities/refresh', { data: {}, timeout: PROBE_TIMEOUT_MS })
  expect((await request.put(`/api/mcp/defaults/${GONE}`, { data: { enabled: false } })).ok()).toBe(true)
  const id = await seedTask(`E2E gone mcp ${randomUUID().slice(0, 8)}`)
  const chosen = await request.put(`/api/tasks/${id}/mcp`, { data: { mcp_enabled: [GONE], mcp_disabled: [] } })
  expect(chosen.ok()).toBe(true)
  return id
}

/** Adds the server again: it must start from the defaults, with no choice left from before. */
async function expectFreshStart(request: APIRequestContext, taskId: string): Promise<void> {
  expect((await request.post('/api/mcp/servers', { data: GONE_SERVER })).ok()).toBe(true)
  try {
    await request.post('/api/capabilities/refresh', { data: {}, timeout: PROBE_TIMEOUT_MS })
    const selection = await apiData<McpSelectionEntry[]>(request, '/mcp/selection')
    expect(selection.find((entry) => entry.name === GONE)).toMatchObject({ default_enabled: true })
    const servers = await apiData<TaskMcpServer[]>(request, `/tasks/${taskId}/mcp`)
    expect(servers.find((s) => s.name === GONE)).toMatchObject({ choice: null, enabled: true })
  } finally {
    await request.delete(`/api/mcp/servers/${GONE}?scope=user`)
  }
}

test('a server deleted from the Claude Code config leaves Access and the defaults', async ({ page, request }) => {
  test.setTimeout(PROBE_TIMEOUT_MS * 5)
  const id = await chooseServer(request)
  const configFile = path.join(paths.home, '.claude.json')
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { mcpServers: Record<string, unknown> }
  config.mcpServers = Object.fromEntries(Object.entries(config.mcpServers).filter(([name]) => name !== GONE))
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2))

  expect((await apiData<McpSelectionEntry[]>(request, '/mcp/selection')).map((e) => e.name)).not.toContain(GONE)
  await page.goto('/#settings/mcp')
  const main = page.getByRole('main')
  await expect(main.getByText(PROBING)).toBeHidden({ timeout: PROBE_TIMEOUT_MS })
  await expect(main.getByRole('switch', { name: `${GONE} on by default` })).toHaveCount(0)
  await expect(main.getByText(GONE)).toHaveCount(0)

  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Access')
  await page.getByRole('button', { name: 'Edit access' }).click()
  const servers = page.getByRole('dialog', { name: /^Access of / }).getByRole('region', { name: 'MCP servers' })
  await expect(servers).toBeVisible()
  await expect(servers.getByRole('switch', { name: GONE })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await request.post('/api/capabilities/refresh', { data: {}, timeout: PROBE_TIMEOUT_MS })
  await expect
    .poll(async () => (await apiData<AuditPage>(request, '/audit?kind=mcp.choices_forgotten&limit=5')).events)
    .toContainEqual(expect.objectContaining({ detail: { servers: [GONE] } }))
  await expectFreshStart(request, id)
})

test("removing a server in Seti forgets its default and agents' choices at once", async ({ request }) => {
  test.setTimeout(PROBE_TIMEOUT_MS * 4)
  const id = await chooseServer(request)
  expect((await request.delete(`/api/mcp/servers/${GONE}?scope=user`)).ok()).toBe(true)
  await expectFreshStart(request, id)
})
