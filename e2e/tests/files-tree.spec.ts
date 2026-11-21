import { seedTreeAgent, treeRow } from './support/files-tree.js'
import { expect, test } from './support/fixtures.js'
import { filesPanel } from './support/viewer-files.js'

test('the tree shows each folder with its size, marks rebuildable ones and opens files', async ({ page }) => {
  const { id, label } = await seedTreeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await panel.getByRole('combobox', { name: 'Root' }).selectOption({ label: 'Tree' })
  const tree = panel.getByRole('list', { name: 'Folder tree' })

  const root = tree.getByRole('button', { name: treeRow(label) })
  await expect(root).toHaveAttribute('aria-expanded', 'false')
  await root.click()
  await expect(root).toHaveAttribute('aria-expanded', 'true')
  const modules = tree.getByRole('button', { name: 'node_modules, rebuildable, 4 KB' })
  await expect(modules).toBeVisible({ timeout: 20_000 })
  await expect(modules).toHaveAttribute('aria-expanded', 'false')

  await tree.getByRole('button', { name: treeRow('src') }).click()
  await tree.getByRole('button', { name: treeRow('main.ts') }).click()
  await expect(panel.getByRole('region', { name: 'File src/main.ts' })).toBeVisible()
  await expect(panel.getByText('export const treeGrown = true')).toBeVisible()

  await page.goto(`/#agents/${id}/files/tree/`)
  await expect(panel.getByRole('combobox', { name: 'Root' })).toHaveValue('tree')
  await expect(panel.getByRole('list', { name: 'Folder tree' })).toBeVisible()
})
