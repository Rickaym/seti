import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIND_FILE, seedFindAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

/** The text of each range find marks as the current match. */
const currentMatches = async (page: Page) =>
  page.evaluate(() => {
    const current = CSS.highlights.get('seti-find-current')
    return current === undefined ? [] : [...current].map((range) => (range as Range).toString())
  })

test('Ctrl+F finds in an open file and Ctrl+G goes to a line, leaving chat find closed', async ({ page }) => {
  const { id } = await seedFindAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await openViewerFile(page, 'find.ts')
  await panel.locator('[data-code-file]').getByText('const line2 = 2').click()

  await page.keyboard.press('Control+f')
  const field = panel.getByRole('searchbox', { name: 'Find in file' })
  await expect(field).toBeFocused()
  await expect(page.getByTestId('chat-find')).toHaveCount(0)
  await expect(panel.getByRole('textbox', { name: 'Search files by name' })).toHaveCount(0)
  await expect(panel.getByRole('textbox', { name: 'Replace with' })).toHaveCount(0)

  await field.fill('needle')
  const count = panel.getByTestId('file-find-count')
  await expect(count).toHaveText('1 of 3')
  expect(await currentMatches(page)).toEqual(['needle'])
  await page.keyboard.press('Enter')
  await expect(count).toHaveText('2 of 3')
  await page.keyboard.press('F3')
  await expect(count).toHaveText('3 of 3')
  await page.keyboard.press('Shift+F3')
  await expect(count).toHaveText('2 of 3')
  await page.keyboard.press('Shift+Enter')
  await expect(count).toHaveText('1 of 3')

  await field.fill('Needle')
  await panel.getByRole('button', { name: 'Match case' }).click()
  await expect(count).toHaveText('No matches')
  await page.keyboard.press('Escape')
  await expect(panel.getByTestId('file-find')).toHaveCount(0)
  await expect.poll(async () => currentMatches(page)).toEqual([])

  await page.keyboard.press('Control+g')
  const line = panel.getByRole('textbox', { name: 'Go to line' })
  await expect(line).toBeFocused()
  await line.fill('46')
  await page.keyboard.press('Enter')
  const marked = panel.locator('mark[data-line="46"]')
  await expect(marked).toHaveText(FIND_FILE.split('\n')[45] ?? '')
  await expect(marked).toBeInViewport()
  await expect(panel.getByTestId('file-find')).toHaveCount(0)

  await page.getByRole('region', { name: 'Transcript' }).click()
  await page.keyboard.press('Control+f')
  await expect(page.getByTestId('chat-find')).toBeVisible()
  await expect(panel.getByTestId('file-find')).toHaveCount(0)
})

test('the editor finds, replaces, selects the next match, undoes and saves', async ({ page }) => {
  const { id, dir } = await seedFindAgent()
  const onDisk = () => fs.readFileSync(path.join(dir, 'docs', 'find.ts'), 'utf8')
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await openViewerFile(page, 'find.ts')
  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Edit docs/find.ts' })).toBeFocused()

  await page.keyboard.press('Control+h')
  await expect(page.getByTestId('chat-find')).toHaveCount(0)
  const field = panel.getByRole('searchbox', { name: 'Find in file' })
  await expect(field).toBeFocused()
  await field.fill('needle')
  const count = panel.getByTestId('file-find-count')
  await expect(count).toHaveText('1 of 3')
  await panel.getByRole('textbox', { name: 'Replace with' }).fill('pin')
  await page.keyboard.press('Enter')
  await expect(count).toHaveText('1 of 2')
  await panel.getByRole('button', { name: 'All', exact: true }).click()
  await expect(count).toHaveText('No matches')

  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+f')
  await field.fill('needle')
  await expect(count).toHaveText(/ of 2$/u)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+y')
  await page.keyboard.press('Control+f')
  await field.fill('pin')
  await expect(count).toHaveText(/ of 3$/u)

  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+d')
  await page.keyboard.type('tack')
  await page.keyboard.press('Control+s')
  await expect.poll(onDisk).toContain("'tack'")
  const text = onDisk()
  expect(text.match(/'tack'/gu)).toHaveLength(2)
  expect(text.match(/'pin'/gu)).toHaveLength(1)
  expect(text).not.toContain('needle')
})
