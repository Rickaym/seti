import type { Page } from '@playwright/test'
import type { AuditPage, Task } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { seedOlderAgent } from './support/older-agent.js'

async function open(page: Page, taskId: string, section: 'General' | 'Access' = 'General') {
  await page.goto(`/#agents/${taskId}`)
  return openAgentSettings(page, section)
}

test("a new agent's settings show its folder to read and copy, with nothing to add or change", async ({
  page,
  request,
}) => {
  const created = await request.post('/api/tasks', {
    data: { title: unique('Own folder'), prompt: 'Say hello', sandbox: false },
  })
  const task = ((await created.json()) as { data: Task }).data
  const details = await open(page, task.id)
  const folder = details.getByRole('definition').filter({ has: page.getByRole('group', { name: task.cwd }) })
  await expect(details.getByRole('term').filter({ hasText: /^Folder$/ })).toBeVisible()
  await expect(folder.getByRole('group')).toHaveCount(1)
  await expect(folder.getByRole('img', { name: 'Runs here' })).toHaveCount(0)
  await expect(folder.getByRole('button')).toHaveCount(1)
  await folder.getByRole('button', { name: /^Copy path of / }).hover()
  await expect(page.getByRole('tooltip')).toContainText(task.cwd)
  for (const gone of [/^Add/, /^Work in /, /^Remove /]) {
    await expect(details.getByRole('button', { name: gone })).toHaveCount(0)
  }
  await showAccessHasNoHomeFolders(page)
  await page.goto('/#agents')
  expect((await request.delete(`/api/tasks/${task.id}`)).ok()).toBe(true)
})

async function showAccessHasNoHomeFolders(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Access', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Access' }).locator('dt')).not.toContainText(['Home folders'])
}

test("an older agent's repo worktree and directory stay, read-only, and its home folders can only be removed", async ({
  page,
  request,
}) => {
  const { id, slug, notes } = await seedOlderAgent('E2E older agent')
  const details = await open(page, id)
  const repoRow = details.getByRole('group', { name: slug })
  await expect(repoRow.getByRole('img', { name: 'Runs here' })).toBeVisible()
  await expect(repoRow.getByRole('button', { name: /, a worktree$/ })).toBeVisible()
  await expect(details.getByRole('group', { name: notes })).toBeVisible()
  await expect(details.getByRole('group', { name: notes }).getByRole('img', { name: 'Runs here' })).toHaveCount(0)
  for (const gone of [/^Add/, /^Work in /, /^Remove /]) {
    await expect(details.getByRole('button', { name: gone })).toHaveCount(0)
  }
  expect(await apiData<Task>(request, `/tasks/${id}`)).toMatchObject({
    cwd: paths.checkout,
    dirs: [notes],
    home_access: true,
    repos: [{ slug, dir: paths.checkout, worktree: true }],
  })
  const patched = await request.patch(`/api/tasks/${id}`, { data: { cwd: notes } })
  expect(patched.ok()).toBe(true)
  expect((await apiData<Task>(request, `/tasks/${id}`)).cwd).toBe(paths.checkout)

  await page.getByRole('tab', { name: 'Access', exact: true }).click()
  const access = page.getByRole('tabpanel', { name: 'Access' })
  await expect(access.locator('dt').filter({ hasText: /^Home folders$/ })).toBeVisible()
  await access.getByText('Writable', { exact: true }).hover()
  await expect(page.getByRole('tooltip')).toContainText('can read and write the folders in your home')
  await access.getByRole('button', { name: 'Remove', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove home folders?' })
  await expect(confirm).toContainText('This cannot be turned back on.')
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' }).first()).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).home_access).toBe(false)
  await expect(access.locator('dt').filter({ hasText: /^Home folders$/ })).toHaveCount(0)

  const events = await apiData<AuditPage>(request, '/audit?kind=task.access_changed&limit=20')
  expect(events.events.find((event) => event.subject_id === id)).toMatchObject({
    actor: 'user',
    summary: 'Took your home folders out of the sandbox of task "E2E older agent"',
  })
  const back = await request.patch(`/api/tasks/${id}`, { data: { home_access: true } })
  expect(back.status()).toBe(400)
  await page.goto('/#agents')
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
