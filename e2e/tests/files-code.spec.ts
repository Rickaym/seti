import fs from 'node:fs'
import path from 'node:path'
import { CODE_FILES, seedCodeAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test('code files open coloured by their extension, with line numbers', async ({ page }) => {
  const { id } = await seedCodeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)

  await openViewerFile(page, 'app.ts')
  const ts = panel.locator('[data-code-file]')
  await expect(ts.locator('code[data-language="typescript"]')).toHaveAttribute('data-highlighted', '')
  await expect(ts.locator('.tok-keyword').first()).toHaveText('export')
  await expect(ts.locator('.tok-string')).toHaveText("'Hello '")
  await expect(ts.locator('[data-line-numbers]')).toHaveText('1\n2\n3')
  expect(await ts.locator('code').textContent()).toBe(CODE_FILES['app.ts'].trimEnd())

  await openViewerFile(page, 'tool.py')
  await expect(panel.locator('[data-code-file] .tok-keyword').first()).toHaveText('def')
  await expect(panel.locator('[data-code-file] .tok-literal')).toHaveText('42')

  await openViewerFile(page, 'data.json')
  await expect(panel.locator('[data-code-file] .tok-function').first()).toHaveText('"name"')
  await expect(panel.locator('[data-code-file] [data-line-numbers]')).toHaveText('1\n2\n3\n4')

  await openViewerFile(page, 'huge.ts')
  await expect(panel.getByText('Too large to colour; showing plain text.')).toBeVisible()
  await expect(panel.locator('[data-code-file]')).toHaveCount(0)
})

test('editing a code file colours it in the editor and still saves', async ({ page }) => {
  const { id, dir } = await seedCodeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)

  await openViewerFile(page, 'app.ts')
  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = panel.locator('[data-code-editor]')
  await expect(editor.locator('.tok-keyword').first()).toHaveText('export')
  const field = panel.getByRole('textbox', { name: 'Edit docs/app.ts' })
  await expect(field).toBeFocused()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('export const answer = 42\n')
  await expect(editor.locator('.tok-literal', { hasText: '42' })).toHaveCount(1)
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => fs.readFileSync(path.join(dir, 'docs', 'app.ts'), 'utf8'))
    .toBe(`${CODE_FILES['app.ts']}export const answer = 42\n`)
  await expect(panel.getByText('Unsaved changes')).toHaveCount(0)
})
