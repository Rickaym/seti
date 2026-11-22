import fs from 'node:fs'
import path from 'node:path'
import { expect, test, toasts, unique } from './support/fixtures.js'
import { seedOrphans, seedStorageAgent } from './support/storage.js'

test('Clean shows what it frees and removes only the rebuildable folder', async ({ page }) => {
  const title = unique('Storage clean')
  const { dir } = await seedStorageAgent(title)
  await page.goto('/#settings/storage')
  const agents = page.getByRole('main').getByRole('list', { name: 'Agents by size' })
  await agents.getByRole('button', { name: `Clean ${title}` }).click()

  const dialog = page.getByRole('dialog', { name: `Clean ${title}` })
  const folders = dialog.getByRole('list', { name: 'Folders to remove' })
  await expect(folders.getByRole('listitem')).toHaveText([/node_modules\s*6 KB/])
  await expect(dialog).toContainText('freeing 6 KB')
  await dialog.getByRole('button', { name: 'Clean', exact: true }).click()

  await expect(toasts(page).filter({ hasText: `Freed 6 KB from ${title}` })).toBeVisible()
  expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false)
  expect(fs.readFileSync(path.join(dir, 'src', 'main.ts'), 'utf8')).toContain('answer')
})

test('Orphans lists folders no agent owns, removes them and keeps unsaved work', async ({ page }) => {
  const { plain, dirty } = seedOrphans(unique('orphan'))
  await page.goto('/#settings/storage')
  const orphans = page.getByRole('main').getByRole('region', { name: 'Orphans' })
  const kept = orphans.getByRole('checkbox', { name: `Remove ${dirty}` })
  await expect(orphans.getByRole('listitem').filter({ hasText: dirty })).toContainText('has uncommitted changes')
  await expect(kept).toBeDisabled()

  await orphans.getByRole('checkbox', { name: `Remove ${plain}` }).click()
  await orphans.getByRole('button', { name: 'Remove 1' }).click()
  await page.getByRole('dialog', { name: 'Remove orphans' }).getByRole('button', { name: 'Remove' }).click()

  await expect(toasts(page).filter({ hasText: 'Removed 1 orphan' })).toBeVisible()
  expect(fs.existsSync(plain)).toBe(false)
  expect(fs.existsSync(path.join(dirty, 'README.md'))).toBe(true)
  await expect(orphans.getByRole('listitem').filter({ hasText: plain })).toHaveCount(0)
})

test('the automatic clean starts off and turns on with a choice of idle days', async ({ page }) => {
  await page.goto('/#settings/storage')
  const card = page.getByRole('main').getByRole('region', { name: 'Automatic clean' })
  const toggle = card.getByRole('switch', { name: 'Automatic clean' })
  await expect(toggle).not.toBeChecked()
  await card.getByRole('combobox', { name: 'Idle days' }).selectOption('30')
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(card.getByRole('combobox', { name: 'Idle days' })).toHaveValue('30')
  await toggle.click()
  await expect(toggle).not.toBeChecked()
})
