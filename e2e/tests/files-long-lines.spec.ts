import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from './support/fixtures.js'
import { longestTask, seedLongLineAgent, watchLongTasks } from './support/long-lines.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test('a page with one huge line opens plain at once, and an 8 MB page previews without its source', async ({
  page,
}) => {
  await watchLongTasks(page)
  const { id, dir } = await seedLongLineAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)

  await openViewerFile(page, 'long-line.html')
  await expect(panel.locator('iframe[title="Preview of long-line.html"]')).toBeVisible()
  await panel.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(panel.getByText('A line is too long to colour; showing plain text.')).toBeVisible()
  await expect(panel.locator('[data-code-file]')).toHaveCount(0)
  const text = panel.locator('pre').filter({ hasText: 'window.DATA=' })
  await expect(text).toContainText('Paragraph 160 of the report.')
  expect(await panel.locator('*').count()).toBeLessThan(500)
  await text.evaluate((el) => {
    el.parentElement?.scrollTo({ top: el.scrollHeight })
  })
  await expect(text.getByText('</html>', { exact: false })).toBeInViewport()

  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Edit docs/long-line.html' })).toBeVisible()
  await expect(panel.locator('[data-code-editor] .cm-content')).toBeVisible()
  await expect(panel.getByText('A line is too long to colour; showing plain text.')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('<!-- ok -->')
  await page.keyboard.press('Control+s')
  await expect.poll(() => fs.readFileSync(path.join(dir, 'docs', 'long-line.html'), 'utf8')).toMatch(/<!-- ok -->$/)
  await panel.getByRole('button', { name: 'Stop editing' }).click()
  expect(await longestTask(page)).toBeLessThan(1_000)

  await openViewerFile(page, 'huge-page.html')
  const huge = panel.frameLocator('iframe[title="Preview of huge-page.html"]')
  await expect(huge.getByText('Paragraph 3882 of the report.')).toBeAttached()
  await expect(panel.getByRole('button', { name: 'Source', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('link', { name: 'Download huge-page.html' })).toHaveAttribute(
    'download',
    'huge-page.html',
  )
  await expect(panel.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await expect(panel.locator('pre')).toHaveCount(0)
  expect(await longestTask(page)).toBeLessThan(1_000)
})
