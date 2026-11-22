import { seedTreeAgent, treeRow } from './support/files-tree.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { filesPanel } from './support/viewer-files.js'

test('the tree fits the files sheet with rows a finger can tap', async ({ page }) => {
  const { id, label } = await seedTreeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  const panel = filesPanel(page)
  await panel.getByRole('combobox', { name: 'Root' }).selectOption({ label: 'Tree' })
  const tree = panel.getByRole('list', { name: 'Folder tree' })

  const root = tree.getByRole('button', { name: treeRow(label) })
  await expectTouchTarget(root)
  await root.tap()
  await expect(tree.getByRole('button', { name: 'node_modules, rebuildable, 4 KB' })).toBeVisible({
    timeout: 20_000,
  })
  await tree.getByRole('button', { name: treeRow('src') }).tap()
  await expectFitsPhone(page, 'the folder tree')

  await tree.getByRole('button', { name: treeRow('main.ts') }).tap()
  await expect(panel.getByRole('region', { name: 'File src/main.ts' })).toBeVisible()
})
