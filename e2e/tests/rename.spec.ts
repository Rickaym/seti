import { randomUUID } from 'node:crypto'
import type { Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'

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

test('renames an agent from its header, and Escape cancels', async ({ page, request }) => {
  const tag = randomUUID().slice(0, 8)
  const id = await seedTask(`E2E old name ${tag}`)
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')

  await main.getByRole('button', { name: 'Rename agent' }).click()
  const name = main.getByLabel('Agent name')
  await name.fill('Scrapped name')
  await name.press('Escape')
  await expect(main.getByRole('heading', { name: `E2E old name ${tag}` })).toBeVisible()

  await main.getByRole('button', { name: 'Rename agent' }).click()
  await main.getByLabel('Agent name').fill(`E2E new name ${tag}`)
  await main.getByLabel('Agent name').press('Enter')
  await expect(toasts(page).filter({ hasText: `Renamed to "E2E new name ${tag}"` })).toBeVisible()
  await expect(main.getByRole('heading', { name: `E2E new name ${tag}` })).toBeVisible()
  await expect(page.locator(`[data-task-id="${id}"]`)).toContainText(`E2E new name ${tag}`)
  expect((await apiData<Task>(request, `/tasks/${id}`)).title).toBe(`E2E new name ${tag}`)
})
