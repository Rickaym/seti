import fs from 'node:fs'
import path from 'node:path'
import { seedCodeAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { filesPanel, textOutsideSelect } from './support/viewer-files.js'

test('the folder row shows only folders below the root, and Up and each folder go back', async ({ page }) => {
  const { id, dir } = await seedCodeAgent()
  fs.mkdirSync(path.join(dir, 'docs', 'deep'))
  fs.writeFileSync(path.join(dir, 'docs', 'deep', 'note.md'), '# Deep\n')
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  const folder = panel.getByRole('navigation', { name: 'Folder' })
  const files = panel.getByRole('list', { name: 'Files' })
  await expect(files).toBeVisible()
  await expect(folder).toHaveCount(0)

  const select = panel.getByRole('combobox', { name: 'Root' })
  const label = path.basename(dir)
  await select.selectOption({ label })
  await expect(select.locator('option:checked')).toHaveText(label)
  await expect(files.getByRole('button', { name: /^docs/ })).toBeVisible()
  await expect(folder).toHaveCount(0)
  expect(await panel.evaluate(textOutsideSelect, label)).toBe(0)

  await files.getByRole('button', { name: /^docs/ }).click()
  await files.getByRole('button', { name: /^deep/ }).click()
  await expect(files.getByRole('button', { name: /^note\.md/ })).toBeVisible()
  await expect(folder).toContainText('docsdeep')
  await expect(folder).not.toContainText(label)
  await expect(folder.locator('[aria-current="location"]')).toHaveText('deep')

  await folder.getByRole('button', { name: 'docs' }).click()
  await expect(folder.locator('[aria-current="location"]')).toHaveText('docs')
  await files.getByRole('button', { name: /^deep/ }).click()
  await expect(folder.locator('[aria-current="location"]')).toHaveText('deep')

  const up = folder.getByRole('button', { name: 'Up a folder' })
  await up.focus()
  await page.keyboard.press('Enter')
  await expect(folder.locator('[aria-current="location"]')).toHaveText('docs')
  await page.keyboard.press('Enter')
  await expect(folder).toHaveCount(0)
  await expect(panel).toBeFocused()
  await expect(files.getByRole('button', { name: /^docs/ })).toBeVisible()

  await select.selectOption({ label: 'Tree' })
  await expect(panel.getByRole('list', { name: 'Folder tree' })).toBeVisible()
  await expect(folder).toHaveCount(0)
  await expect(panel.getByText('Every folder, with its size')).toHaveCount(0)
})
