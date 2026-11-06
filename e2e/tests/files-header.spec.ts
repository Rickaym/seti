import fs from 'node:fs'
import path from 'node:path'
import { CODE_FILES, seedCodeAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test('Edit sits beside Download, and editing puts Save in its place', async ({ page }) => {
  const { id, dir } = await seedCodeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await openViewerFile(page, 'app.ts')

  const header = panel.getByTestId('viewer-header')
  const edit = header.getByRole('button', { name: 'Edit', exact: true })
  const download = header.getByRole('link', { name: 'Download app.ts' })
  await expect(edit).toBeVisible()
  const editBox = await edit.boundingBox()
  const downloadBox = await download.boundingBox()
  expect(Math.abs((editBox?.y ?? 0) - (downloadBox?.y ?? 0))).toBeLessThan(2)
  expect((downloadBox?.x ?? 0) - ((editBox?.x ?? 0) + (editBox?.width ?? 0))).toBeLessThan(12)

  await edit.click()
  await expect(edit).toHaveCount(0)
  const save = header.getByRole('button', { name: 'Save' })
  await expect(save).toBeDisabled()
  await expect(header.getByRole('button', { name: 'Stop editing' })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('// saved\n')
  await expect(header.getByText('Unsaved changes')).toBeVisible()
  await save.click()
  await expect
    .poll(() => fs.readFileSync(path.join(dir, 'docs', 'app.ts'), 'utf8'))
    .toBe(`${CODE_FILES['app.ts']}// saved\n`)
  await expect(header.getByText('Unsaved changes')).toHaveCount(0)

  await header.getByRole('button', { name: 'Stop editing' }).click()
  await expect(header.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  await expect(save).toHaveCount(0)
})
