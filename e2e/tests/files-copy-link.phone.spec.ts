import { seedCodeAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test('Copy link on a phone gives a link that reopens the file', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const { id } = await seedCodeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  await openViewerFile(page, 'data.json')

  const copy = filesPanel(page).getByTestId('viewer-header').getByRole('button', { name: 'Copy link' })
  expect((await copy.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'the viewer header with Copy link')
  await copy.tap()
  await expect(copy).toHaveAttribute('data-copied', '')
  const link = await page.evaluate(async () => navigator.clipboard.readText())
  expect(link).toMatch(/\/docs\/data\.json$/)

  await page.goto('/#settings')
  await page.goto(link)
  await expect(page.getByRole('region', { name: 'File docs/data.json' })).toBeVisible()
  await expect(page.locator('[data-code-file] .tok-function').first()).toHaveText('"name"')
})
