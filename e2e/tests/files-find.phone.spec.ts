import { seedFindAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test('the Find button opens find in a file on a phone and it fits the screen', async ({ page }) => {
  const { id } = await seedFindAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  const panel = filesPanel(page)
  await openViewerFile(page, 'find.ts')

  await panel.getByRole('button', { name: 'Find in file' }).tap()
  const field = panel.getByRole('searchbox', { name: 'Find in file' })
  await expect(field).toBeFocused()
  await field.fill('needle')
  const count = panel.getByTestId('file-find-count')
  await expect(count).toHaveText('1 of 3')
  await panel.getByRole('button', { name: 'Next match' }).tap()
  await expect(count).toHaveText('2 of 3')
  await expect(panel.getByRole('button', { name: 'Close find' })).toBeInViewport()
  await expectFitsPhone(page, 'find in a file')

  await panel.getByRole('button', { name: 'Edit', exact: true }).tap()
  await panel.getByRole('button', { name: 'Find in file' }).tap()
  await panel.getByRole('button', { name: 'Replace', exact: true }).tap()
  await expect(panel.getByRole('textbox', { name: 'Replace with' })).toBeVisible()
  await expectFitsPhone(page, 'find and replace in the editor')
})
