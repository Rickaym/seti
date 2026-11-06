import { randomUUID } from 'node:crypto'
import { BUILTIN_ROLES, type ContextPackSummary } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const WATCHER = BUILTIN_ROLES.find((role) => role.name === 'Watcher')?.text ?? ''

async function seedPinned(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, sandbox, status, created_at, updated_at, pinned)
     VALUES (?, ?, NULL, ?, 0, 1, 'idle', ?, ?, true)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  await db.close()
  return id
}

test('the role picker and the new role editor fit a phone', async ({ page }) => {
  const title = `Phone watcher ${randomUUID().slice(0, 6)}`
  const id = await seedPinned(title)
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: title, level: 2 })).toBeVisible()
  await main.getByRole('button', { name: 'Agent settings' }).tap()
  const details = page.getByRole('dialog').getByLabel('Agent details')
  await expect(details).toContainText('Pinned agents work best with a role')
  await expectFitsPhone(page, 'agent details with the role hint')
  await details.getByRole('combobox', { name: 'Role' }).selectOption({ label: 'New role...' })

  const dialog = page.getByRole('dialog', { name: `New role for ${title}` })
  await dialog.getByRole('button', { name: 'Watcher' }).tap()
  await expect(dialog.getByRole('textbox', { name: 'Role content' })).toHaveValue(WATCHER)
  await expectFitsPhone(page, 'new role editor')
  await dialog.getByRole('button', { name: 'Save' }).tap()
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
  const linked = await apiData<ContextPackSummary[]>(page.request, `/tasks/${id}/context-packs`)
  expect(linked.find((pack) => pack.kind === 'role')?.name).toBe(`${title} role`)

  await main.getByRole('button', { name: 'Agent settings' }).tap()
  await expect(details.getByTestId('task-role')).toContainText('Watcher: you monitor channels')
  await expectFitsPhone(page, 'agent details with a role')
})
