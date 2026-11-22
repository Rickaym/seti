import fs from 'node:fs'
import path from 'node:path'
import { expect, test, toasts, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { seedOrphans, seedStorageAgent } from './support/storage.js'

test('Storage fits a phone: Clean an agent and remove an orphan by touch', async ({ page }) => {
  const title = unique('Phone clean')
  const { dir } = await seedStorageAgent(title)
  const { plain, dirty } = seedOrphans(unique('phone-orphan'))
  await page.goto('/#settings/storage')
  const main = page.getByRole('main')
  const clean = main.getByRole('list', { name: 'Agents by size' }).getByRole('button', { name: `Clean ${title}` })
  await expect(clean).toBeVisible()
  expect((await clean.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(32)
  await expect(
    main.getByRole('region', { name: 'Orphans' }).getByRole('listitem').filter({ hasText: dirty }),
  ).toContainText('has uncommitted changes')
  await expectFitsPhone(page, 'the Storage page')

  await clean.tap()
  const dialog = page.getByRole('dialog', { name: `Clean ${title}` })
  await expect(dialog.getByRole('list', { name: 'Folders to remove' })).toContainText('node_modules')
  await expectFitsPhone(page, 'the Clean preview')
  await dialog.getByRole('button', { name: 'Clean', exact: true }).tap()
  await expect(toasts(page).filter({ hasText: `Freed 6 KB from ${title}` })).toBeVisible()
  expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false)

  const orphans = main.getByRole('region', { name: 'Orphans' })
  await orphans.getByRole('checkbox', { name: `Remove ${plain}` }).tap()
  await orphans.getByRole('button', { name: 'Remove 1' }).tap()
  await page.getByRole('dialog', { name: 'Remove orphans' }).getByRole('button', { name: 'Remove' }).tap()
  await expect(toasts(page).filter({ hasText: 'Removed 1 orphan' })).toBeVisible()
  expect(fs.existsSync(plain)).toBe(false)
  expect(fs.existsSync(dirty)).toBe(true)
})
