import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, PermissionPolicy, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { PERMISSION_COMMAND, PERMISSION_DONE, PERMISSION_PROMPT } from './support/fake-permission.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const needsYou = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Needs you' })
const card = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })

async function startBlocked(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title, prompt: `Please ${PERMISSION_PROMPT}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()
  return id
}

test('an agent waiting on a permission sits in Needs you and goes on once allowed', async ({ page, request }) => {
  const id = await startBlocked(request, unique('Deploying agent'))
  expect((await apiData<Task>(request, `/tasks/${id}`)).blocked).toBe(`Asks to use Bash: ${PERMISSION_COMMAND}`)

  await page.goto('/#agents')
  const row = needsYou(page).locator(`[data-task-id="${id}"]`)
  await expect(row.getByRole('img', { name: 'waits on you' })).toBeVisible()
  await expect(row).toContainText(`Asks to use Bash: ${PERMISSION_COMMAND}`)
  await row.getByRole('button').click()

  await expect(card(page)).toContainText(PERMISSION_COMMAND)
  await expect(card(page)).toContainText('No rule allows this command')
  await expect(row, 'it stays in Needs you while open, until answered').toBeVisible()
  await card(page).getByRole('button', { name: 'Allow', exact: true }).click()

  await expect(card(page)).toHaveCount(0)
  await expect(page.getByRole('main').getByText(PERMISSION_DONE, { exact: true })).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  expect((await apiData<Task>(request, `/tasks/${id}`)).blocked).toBeNull()
  await expect(row).toHaveCount(0)
})

test('Deny tells the agent why, and Always allow for all agents adds the rule in Settings', async ({
  page,
  request,
}) => {
  const denied = await startBlocked(request, unique('Denied agent'))
  await page.goto(`/#agents/${denied}`)
  await card(page).getByRole('textbox', { name: 'Note for the agent if you deny' }).fill('Not on a Friday')
  await card(page).getByRole('button', { name: 'Deny' }).click()
  await expect(
    page.getByRole('main').getByText('Did not deploy: The user denied this tool call and said: Not on a Friday'),
  ).toBeVisible()

  const allowed = await startBlocked(request, unique('Always agent'))
  await page.goto(`/#agents/${allowed}`)
  await card(page).getByRole('switch', { name: 'All agents' }).click()
  await card(page).getByRole('button', { name: 'Always' }).click()
  await expect(page.getByRole('main').getByText(PERMISSION_DONE, { exact: true })).toBeVisible()

  const rule = `Bash(${PERMISSION_COMMAND}:*)`
  expect((await apiData<PermissionPolicy>(request, '/permissions')).rules.map((r) => r.rule)).toContain(rule)
  await page.goto('/#settings/permissions')
  const rules = page.getByRole('region', { name: 'Global rules' })
  await expect(rules.getByText(rule, { exact: true })).toBeVisible()
  await rules.getByRole('button', { name: `Remove allow rule ${rule}` }).click()
  await expect(rules.getByText(rule, { exact: true })).toHaveCount(0)
})

test("Settings lists the rules agents load from the user's own Claude Code settings", async ({ page }) => {
  const file = path.join(paths.claudeHome, 'settings.json')
  fs.mkdirSync(paths.claudeHome, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(aws ssm send-command:*)'] } }))
  try {
    await page.goto('/#settings/permissions')
    const inherited = page.getByRole('region', { name: 'Claude Code rules' })
    const row = inherited.getByRole('listitem').filter({ hasText: 'Bash(aws ssm send-command:*)' })
    await expect(row).toContainText('From ~/.claude/settings.json')
    await expect(row.getByRole('button', { name: /^Remove / })).toHaveCount(0)
  } finally {
    fs.rmSync(file, { force: true })
  }
})
