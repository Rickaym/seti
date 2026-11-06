import fs from 'node:fs'
import path from 'node:path'
import { CODE_FILES, seedCodeAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test('the viewer header holds Edit and then Save at touch size on a phone', async ({ page }) => {
  const { id, dir } = await seedCodeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  const panel = filesPanel(page)
  await openViewerFile(page, 'app.ts')

  const header = panel.getByTestId('viewer-header')
  const edit = header.getByRole('button', { name: 'Edit', exact: true })
  expect((await edit.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await edit.tap()
  const save = header.getByRole('button', { name: 'Save' })
  const stop = header.getByRole('button', { name: 'Stop editing' })
  expect((await save.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect((await stop.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'the viewer header while editing')

  await panel.getByRole('textbox', { name: 'Edit docs/app.ts' }).tap()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('// tapped\n')
  await save.tap()
  await expect
    .poll(() => fs.readFileSync(path.join(dir, 'docs', 'app.ts'), 'utf8'))
    .toBe(`${CODE_FILES['app.ts']}// tapped\n`)
})
