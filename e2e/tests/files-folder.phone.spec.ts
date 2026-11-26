import fs from 'node:fs'
import path from 'node:path'
import { seedCodeAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { filesPanel, textOutsideSelect } from './support/viewer-files.js'

test('on a phone the folder row shows only below the root, with Up and folders a finger can tap', async ({ page }) => {
  const { id, dir } = await seedCodeAgent()
  fs.mkdirSync(path.join(dir, 'docs', 'deep'))
  fs.writeFileSync(path.join(dir, 'docs', 'deep', 'note.md'), '# Deep\n')
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  const panel = filesPanel(page)
  const folder = panel.getByRole('navigation', { name: 'Folder' })
  const files = panel.getByRole('list', { name: 'Files' })

  const select = panel.getByRole('combobox', { name: 'Root' })
  const label = path.basename(dir)
  await select.selectOption({ label })
  await expect(files.getByRole('button', { name: /^docs/ })).toBeVisible()
  await expect(folder).toHaveCount(0)
  expect(await panel.evaluate(textOutsideSelect, label)).toBe(0)
  const { width = 0 } = (await select.boundingBox()) ?? {}
  expect(width, 'the Root select has room to show the root it names').toBeGreaterThan(200)
  await expectFitsPhone(page, 'the files sheet at the top of a root')

  await files.getByRole('button', { name: /^docs/ }).tap()
  await files.getByRole('button', { name: /^deep/ }).tap()
  await expect(folder.locator('[aria-current="location"]')).toHaveText('deep')
  await expect(folder).not.toContainText(label)
  const up = folder.getByRole('button', { name: 'Up a folder' })
  const docs = folder.getByRole('button', { name: 'docs' })
  await expectTouchTarget(up, 'Up', 'both')
  await expectTouchTarget(docs, 'docs')
  await expectFitsPhone(page, 'the folder row two levels down')

  await docs.tap()
  await expect(folder.locator('[aria-current="location"]')).toHaveText('docs')
  await up.tap()
  await expect(folder).toHaveCount(0)
  await expect(files.getByRole('button', { name: /^docs/ })).toBeVisible()

  await select.selectOption({ label: 'Tree' })
  await expect(panel.getByRole('list', { name: 'Folder tree' })).toBeVisible()
  await expect(folder).toHaveCount(0)
})
