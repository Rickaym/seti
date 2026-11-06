import { expect, test } from './support/fixtures.js'
import { NEEDLE_LINE, seedSearchAgent } from './support/search-files.js'
import { filesPanel } from './support/viewer-files.js'

const NEEDLE_TEXT = 'const haystackNeedle = findTheNeedle()'

test('Files search finds names and text and opens what it finds', async ({ page }) => {
  const { id } = await seedSearchAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await expect(panel.getByRole('search')).toHaveCount(0)
  await panel.getByRole('button', { name: /notes\.md/ }).click()
  await panel.getByRole('region', { name: 'File notes.md' }).click()

  await page.keyboard.press('Control+f')
  const names = panel.getByRole('textbox', { name: 'Search files by name' })
  await expect(names).toBeFocused()
  await expect(panel.getByRole('button', { name: 'Search files' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('chat-find')).toHaveCount(0)

  await names.fill('srchpnl')
  const results = panel.getByRole('list', { name: 'Search results' })
  const byName = results.getByRole('button', { name: /search-panel\.ts/ })
  await expect(byName).toHaveCount(1)
  await expect(byName.locator('mark')).toHaveText(['s', 'rch', 'p', 'n', 'l'])
  await byName.click()
  await expect(panel.getByRole('region', { name: 'File src/panels/search-panel.ts' })).toBeVisible()
  await expect(panel.getByRole('navigation', { name: 'Folder' })).toContainText('panels')
  await expect(results).toHaveCount(0)

  await names.click()
  await panel.getByRole('button', { name: 'Text', exact: true }).click()
  const text = panel.getByRole('textbox', { name: 'Search inside files' })
  await expect(text).toHaveValue('srchpnl')
  await text.fill('findtheneedle')
  const line = results.getByRole('button', { name: new RegExp(`search-panel\\.ts:${String(NEEDLE_LINE)}`) })
  await expect(line).toBeVisible()
  await expect(results.getByRole('button')).toHaveCount(1)
  await expect(line.locator('mark')).toHaveText('findTheNeedle')
  await line.click()
  const marked = panel.locator(`mark[data-line="${String(NEEDLE_LINE)}"]`)
  await expect(marked).toHaveText(NEEDLE_TEXT)
  await expect(marked).toBeInViewport()

  await text.fill('nothing like this anywhere')
  await expect(panel.getByText('No lines in the files match "nothing like this anywhere".')).toBeVisible()
  await panel.getByRole('button', { name: 'Clear search' }).click()
  await expect(text).toHaveValue('')
  await expect(text).toBeFocused()
  await expect(marked).toBeVisible()

  await text.fill('findtheneedle')
  await page.keyboard.press('Escape')
  await expect(panel.getByRole('search')).toHaveCount(0)
  await expect(results).toHaveCount(0)
  await expect(marked).toBeVisible()
  await page.keyboard.press('Control+f')
  await expect(text).toBeFocused()
  await expect(text).toHaveValue('')
})

test('Ctrl+F outside Files leaves the Files search closed', async ({ page }) => {
  const { id } = await seedSearchAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await expect(panel.getByRole('button', { name: /notes\.md/ })).toBeVisible()
  await page.getByRole('region', { name: 'Transcript' }).click()
  await page.keyboard.press('Control+f')
  await expect(panel.getByRole('search')).toHaveCount(0)

  await panel.getByRole('button', { name: 'Search files' }).click()
  await expect(panel.getByRole('textbox', { name: 'Search files by name' })).toBeFocused()
  await panel.getByRole('button', { name: 'Search files' }).click()
  await expect(panel.getByRole('search')).toHaveCount(0)
})
