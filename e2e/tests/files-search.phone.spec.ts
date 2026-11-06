import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { seedSearchAgent } from './support/search-files.js'
import { filesPanel } from './support/viewer-files.js'

test('the files sheet puts search on top and its results fill the sheet', async ({ page }) => {
  const { id } = await seedSearchAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  const panel = filesPanel(page)
  const search = panel.getByRole('search')
  await expect(panel.getByRole('button', { name: /notes\.md/ })).toBeVisible()
  await expect(search).toHaveCount(0)
  const open = panel.getByRole('button', { name: 'Search files' })
  expect((await open.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await open.tap()
  const field = search.getByRole('textbox', { name: 'Search files by name' })
  await expect(field).toBeFocused()
  const sheet = await panel.boundingBox()
  const bar = await search.boundingBox()
  expect((bar?.y ?? 0) - (sheet?.y ?? 0)).toBeLessThan(4)

  await field.fill('panel')
  const results = panel.getByRole('list', { name: 'Search results' })
  const hit = results.getByRole('button', { name: /search-panel\.ts/ })
  await expect(hit).toBeVisible()
  const list = await results.boundingBox()
  expect((list?.y ?? 0) + (list?.height ?? 0)).toBeGreaterThan((sheet?.y ?? 0) + (sheet?.height ?? 0) - 4)
  await expectFitsPhone(page, 'files search results')

  await hit.tap()
  await expect(panel.getByRole('region', { name: 'File src/panels/search-panel.ts' })).toBeVisible()
  await open.tap()
  await expect(search).toHaveCount(0)
})
