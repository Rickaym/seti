import { expect, test } from './support/fixtures.js'
import { longestTask, seedLongLineAgent, watchLongTasks } from './support/long-lines.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test('a page with one huge line opens plain on a phone, and an 8 MB page previews without its source', async ({
  page,
}) => {
  await watchLongTasks(page)
  const { id } = await seedLongLineAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  const panel = filesPanel(page)

  await openViewerFile(page, 'long-line.html')
  await expect(panel.locator('iframe[title="Preview of long-line.html"]')).toBeVisible()
  await panel.getByRole('button', { name: 'Source', exact: true }).tap()
  await expect(panel.getByText('A line is too long to colour; showing plain text.')).toBeVisible()
  await expect(panel.locator('[data-code-file]')).toHaveCount(0)
  const text = panel.locator('pre').filter({ hasText: 'window.DATA=' })
  await expect(text).toContainText('Paragraph 160 of the report.')
  expect(await panel.locator('*').count()).toBeLessThan(500)
  await expectFitsPhone(page, 'a page with one huge line')
  await panel.getByRole('button', { name: 'Edit', exact: true }).tap()
  await expect(panel.locator('[data-code-editor] .cm-content')).toBeVisible()
  await expectFitsPhone(page, 'the editor on a huge line')
  await panel.getByRole('button', { name: 'Stop editing' }).tap()
  expect(await longestTask(page)).toBeLessThan(1_000)

  await openViewerFile(page, 'huge-page.html')
  const huge = panel.frameLocator('iframe[title="Preview of huge-page.html"]')
  await expect(huge.getByText('Paragraph 3882 of the report.')).toBeAttached()
  await expect(panel.getByRole('button', { name: 'Source', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('link', { name: 'Download huge-page.html' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await expectFitsPhone(page, 'an 8 MB page')
})
