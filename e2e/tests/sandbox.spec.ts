import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import {
  DEFAULT_ALLOWED_DOMAINS,
  WEBFETCH_BLOCKED,
  type AuditPage,
  type SandboxPolicyInput,
  type SandboxStatus,
  type Task,
} from '@seti/shared'
import { openSeedDb, type SeedValue } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'

const DEFAULT_POLICY: SandboxPolicyInput = {
  enabled: true,
  allowed_domains: [...DEFAULT_ALLOWED_DOMAINS],
  hidden_paths: [],
}

const statusBar = (page: Page) => page.getByRole('contentinfo')

async function openSettings(page: Page) {
  await page.goto('/')
  await statusBar(page).getByRole('button', { name: 'Sandbox on' }).click()
  await expect(page).toHaveURL(/#settings\/sandbox$/)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Sandbox', level: 2 })).toBeVisible()
  return main
}

const message = (content: unknown[], type: 'assistant' | 'user') => ({
  type,
  message: { id: randomUUID(), type: 'message', role: type, model: 'claude', content },
  parent_tool_use_id: null,
  session_id: 'seeded-sandbox',
  uuid: randomUUID(),
})

/** A finished task that ran without the sandbox, with one refused command and one refused fetch. */
async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, sandbox, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 0, 'idle', ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  const curl = { type: 'tool_use', id: 'toolu_curl', name: 'Bash', input: { command: 'curl https://example.com' } }
  const fetch = { type: 'tool_use', id: 'toolu_fetch', name: 'WebFetch', input: { url: 'https://example.com' } }
  const refused =
    'curl: (56) CONNECT tunnel failed, response 403\n<sandbox_violations>\ndeny network-outbound example.com:443\n</sandbox_violations>'
  const payloads = [
    message([curl], 'assistant'),
    message([{ type: 'tool_result', tool_use_id: 'toolu_curl', content: refused, is_error: true }], 'user'),
    message([fetch], 'assistant'),
    message(
      [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_fetch',
          content: `${WEBFETCH_BLOCKED}: https://example.com is not on it.`,
          is_error: true,
        },
      ],
      'user',
    ),
  ]
  const insert = async (...values: SeedValue[]) =>
    db.run(
      `INSERT INTO task_message (task_id, kind, payload, outward, created_at) VALUES (?, 'sdk', ?, '[]', ?)`,
      ...values,
    )
  for (const payload of payloads) {
    await insert(id, JSON.stringify(payload), ts)
  }
  await db.close()
  return id
}

test.describe('task sandbox', () => {
  test.use({ allowedHttpStatuses: [400] })

  test.afterEach(async ({ request }) => {
    expect((await request.put('/api/sandbox', { data: DEFAULT_POLICY })).ok()).toBe(true)
  })

  test('the settings page turns the sandbox off and on, edits the allowlist and is audited', async ({
    page,
    request,
  }) => {
    const main = await openSettings(page)
    const save = main.getByRole('button', { name: 'Save' })
    await expect(main.getByText('None', { exact: true })).toHaveCount(2)
    await expect(main.getByText(/until then agents cannot reach Claude/)).toBeVisible()
    await expect(main.getByText(/Always hidden: .*~\/\.ssh/)).toBeVisible()
    await expect(save).toBeDisabled()
    const hosts = main.getByRole('textbox', { name: 'Allowed hosts' })
    await expect(hosts).toHaveValue(DEFAULT_ALLOWED_DOMAINS.join('\n'))

    await hosts.fill('github.com\nhttps://bad.example')
    await save.click()
    await expect(toasts(page).filter({ hasText: 'Use a host such as github.com' })).toBeVisible()

    await hosts.fill('github.com\nexample.org')
    await main.getByRole('textbox', { name: 'Hidden paths' }).fill('~/wg0.conf')
    await main.getByRole('switch', { name: 'Sandbox agents' }).click()
    await save.click()
    await expect(toasts(page).filter({ hasText: 'Sandbox saved' })).toBeVisible()
    await expect(save).toBeDisabled()
    await expect(statusBar(page).getByRole('button', { name: 'Sandbox off' })).toBeVisible()

    const saved = await apiData<SandboxStatus>(request, '/sandbox')
    expect(saved.policy).toMatchObject({
      enabled: false,
      allowed_domains: ['github.com', 'example.org'],
      hidden_paths: ['~/wg0.conf'],
    })
    const audit = await apiData<AuditPage>(request, '/audit?kind=system.sandbox_changed&limit=1')
    expect(audit.events[0]?.summary).toBe('Task sandbox turned off')

    await page.reload()
    await expect(main.getByRole('textbox', { name: 'Hidden paths' })).toHaveValue('~/wg0.conf')
    await main.getByRole('switch', { name: 'Sandbox agents' }).click()
    await main.getByRole('button', { name: 'Defaults' }).click()
    await expect(main.getByRole('textbox', { name: 'Allowed hosts' })).toHaveValue(DEFAULT_ALLOWED_DOMAINS.join('\n'))
    await save.click()
    await expect(statusBar(page).getByRole('button', { name: 'Sandbox on' })).toBeVisible()
  })

  test('lists the MCP servers sandboxed agents can use, with their state and no token', async ({ page }) => {
    const access = ['e2e', 'mcp', 'access'].join('-')
    const file = path.join(paths.claudeHome, '.credentials.json')
    fs.mkdirSync(paths.claudeHome, { recursive: true })
    const logins = {
      'tracker|1': { serverName: 'tracker', serverUrl: 'https://mcp.tracker.test/mcp', accessToken: access },
      'stale|2': { serverName: 'stale', serverUrl: 'https://stale.test/mcp', accessToken: '', expiresAt: 1 },
    }
    fs.writeFileSync(file, JSON.stringify({ mcpOAuth: logins }), { mode: 0o600 })
    try {
      const main = await openSettings(page)
      const list = main.getByRole('list', { name: 'MCP servers' })
      await expect(list.getByRole('img', { name: 'tracker: OK' })).toBeVisible()
      await expect(list.getByRole('img', { name: 'stale: Sign in again' })).toBeVisible()
      await expect(list.getByRole('img', { name: 'claude.ai connectors: Log in again' })).toBeVisible()
      await expect(list).toContainText('run /mcp in claude on the host')
      await expect(list).toContainText('a setup-token token cannot reach them')
      await expect(page.locator('body')).not.toContainText(access)
    } finally {
      fs.rmSync(file, { force: true })
    }
  })

  test('unsaved sandbox edits ask before leaving the page', async ({ page }) => {
    const main = await openSettings(page)
    await main.getByRole('textbox', { name: 'Hidden paths' }).fill('~/draft.conf')
    await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General' }).click()
    const confirm = page.getByRole('dialog', { name: 'Confirm' })
    await expect(confirm).toContainText('Discard unsaved changes?')
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(/#settings\/sandbox$/)
    await expect(main.getByRole('textbox', { name: 'Hidden paths' })).toHaveValue('~/draft.conf')
  })

  test('the start page starts sandboxed agents on the default profile', async ({ page, request }) => {
    await page.goto('/#agents/new')
    await page.getByLabel('Message').fill('Tidy the notes folder')
    await page.getByLabel('Message').press('Enter')
    await expect(page).toHaveURL(/#agents\/[\da-f-]{36}$/)
    const id = new URL(page.url()).hash.split('/')[1] ?? ''
    expect(await apiData<Task>(request, `/tasks/${id}`)).toMatchObject({
      sandbox: true,
      profile_id: 'default',
    })
    await page.goto('/#agents')
    expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
  })

  test('unsandboxed tasks carry a badge and refused accesses show in the transcript', async ({ page }) => {
    const title = `E2E sandbox ${randomUUID().slice(0, 8)}`
    const id = await seedTask(title)
    await page.goto(`/#agents/${id}`)
    const item = page.getByRole('button', { name: new RegExp(title) })
    const badge = item.getByRole('img', { name: /^Unsandboxed/ })
    await expect(badge).toBeVisible()
    await expect(item.getByText('unsandboxed')).toHaveCount(0)
    await badge.hover()
    await expect(page.getByRole('tooltip')).toContainText('Unsandboxed')
    const group = page.getByTestId('tool-group')
    await expect(group.getByTestId('tool-group-blocked')).toContainText('2')
    await group.getByRole('button', { name: /Ran 1 command, fetched 1 page/ }).click()
    const blocked = page.getByTestId('sandbox-blocked')
    await expect(blocked).toHaveCount(2)
    await expect(blocked.first()).toHaveAttribute('title', 'deny network-outbound example.com:443')
    await expect(blocked.last()).toHaveAttribute('title', new RegExp(`^${WEBFETCH_BLOCKED}`))
  })
})
