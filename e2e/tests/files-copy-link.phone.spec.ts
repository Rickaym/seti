import { seedCodeAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test('Copy contents on a phone copies the whole file with a touch-sized button', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const { id } = await seedCodeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  await openViewerFile(page, 'data.json')

  const header = filesPanel(page).getByTestId('viewer-header')
  await expect(header.getByRole('button', { name: 'Copy link' })).toHaveCount(0)
  const copy = header.getByRole('button', { name: 'Copy contents' })
  expect((await copy.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'the viewer header with Copy contents')
  await copy.tap()
  await expect(copy).toHaveAttribute('data-copied', '')
  expect(await page.evaluate(async () => navigator.clipboard.readText())).toContain('"name"')
})
