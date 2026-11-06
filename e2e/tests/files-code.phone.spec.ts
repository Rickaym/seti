import fs from 'node:fs'
import path from 'node:path'
import { CODE_FILES, seedCodeAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test('code files colour in and edit on a phone without zooming', async ({ page }) => {
  const { id, dir } = await seedCodeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  const panel = filesPanel(page)

  await openViewerFile(page, 'tool.py')
  const code = panel.locator('[data-code-file]')
  await expect(code.locator('.tok-keyword').first()).toHaveText('def')
  await expect(code.locator('[data-line-numbers]')).toHaveText('1\n2\n3')
  await expectFitsPhone(page, 'a code file')

  await openViewerFile(page, 'app.ts')
  await panel.getByRole('button', { name: 'Edit', exact: true }).tap()
  const field = panel.getByRole('textbox', { name: 'Edit docs/app.ts' })
  await expect(panel.locator('[data-code-editor] .tok-keyword').first()).toHaveText('export')
  expect(await field.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
  await field.tap()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('// phone\n')
  await panel.getByRole('button', { name: 'Save' }).tap()
  await expect
    .poll(() => fs.readFileSync(path.join(dir, 'docs', 'app.ts'), 'utf8'))
    .toBe(`${CODE_FILES['app.ts']}// phone\n`)
  await expectFitsPhone(page, 'the code editor')
})
