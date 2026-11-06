import { randomUUID } from 'node:crypto'
import type { Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'

/** An idle task last touched `ageMinutes` ago, with nothing in its transcript. */
async function seedTask(title: string, ageMinutes: number): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date(Date.now() - ageMinutes * 60_000).toISOString()
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

test('pinning an agent from its header lists it first and survives a reload', async ({ page, request }) => {
  const tag = randomUUID().slice(0, 8)
  const old = await seedTask(`E2E pinned ${tag}`, 60 * 24 * 30)
  const newer = await seedTask(`E2E newer ${tag}`, 1)
  await page.goto(`/#agents/${old}`)
  const pin = page.getByRole('main').getByRole('button', { name: 'Pin', exact: true })
  await expect(pin).toHaveAttribute('aria-pressed', 'false')
  await pin.click()
  await expect(toasts(page).filter({ hasText: `Pinned "E2E pinned ${tag}"` })).toBeVisible()
  await expect(pin).toHaveAttribute('aria-pressed', 'true')
  expect((await apiData<Task>(request, `/tasks/${old}`)).pinned).toBe(true)

  await page.reload()
  const order = async () =>
    page.locator('[data-task-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-task-id')))
  await expect
    .poll(async () => {
      const ids = await order()
      return ids.includes(old) && ids.indexOf(old) < ids.indexOf(newer)
    })
    .toBe(true)
  await expect(page.locator(`[data-task-id="${old}"]`).getByLabel('Pinned')).toBeVisible()

  await page.getByRole('main').getByRole('button', { name: 'Pin', exact: true }).click()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${old}`)).pinned).toBe(false)
})
