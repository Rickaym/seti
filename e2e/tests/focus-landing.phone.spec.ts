import { randomUUID } from 'node:crypto'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

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

test('a keyboard pick in the palette lands on the heading, not the reply box', async ({ page }) => {
  const tag = randomUUID().slice(0, 6)
  const id = await seedTask(`Phone landing ${tag}`)
  await page.goto('/#agents')
  await expect(page.locator(`[data-task-id="${id}"]`)).toBeVisible()

  await page.getByRole('banner').getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Shortcuts' }).click()
  await page.getByRole('dialog', { name: 'Shortcuts' }).getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill(`Phone landing ${tag}`)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))

  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: `Phone landing ${tag}` })).toBeFocused()
  await expect(main.getByRole('combobox', { name: 'Reply' })).not.toBeFocused()
})
