import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { expectDashboardCode, expectRenderedDashboard, RENDER_LINE, seedDashboard } from './support/render-dialog.js'
import { seedShareAgent, setSharing, stranger } from './support/shares.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.beforeEach(async ({ request }) => {
  await setSharing(request, true)
})

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/shares/revoke-all', { data: {} })).ok()).toBe(true)
  await setSharing(request, false)
})

test('a phone shares an HTML file, which renders as its page and fits the phone', async ({
  page,
  browser,
  viewport,
}) => {
  const { id, dir } = await seedShareAgent()
  seedDashboard(dir)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  await openViewerFile(page, 'dashboard.html')
  await filesPanel(page).getByTestId('viewer-header').getByRole('button', { name: 'Share' }).tap()
  const dialog = page.getByRole('dialog', { name: 'Share dashboard.html' })

  const render = dialog.getByRole('switch', { name: /Render/ })
  await expect(render).toBeChecked()
  await expect(dialog.getByText(RENDER_LINE)).toBeVisible()
  await expectTouchTarget(dialog.locator('label').filter({ hasText: RENDER_LINE }))
  await expectFitsPhone(page, 'the share dialog with Render')
  await page.screenshot({ path: test.info().outputPath('render-dialog-phone.png') })
  await dialog.getByRole('button', { name: 'Create link' }).tap()
  const link = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/share\/[A-Za-z0-9_-]{43}$/)
  const url = await link.inputValue()

  const viewer = await stranger(browser, viewport ?? { width: 390, height: 844 })
  try {
    await viewer.page.goto(url)
    await expectRenderedDashboard(viewer.page)
    const overflow = await viewer.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await viewer.page.screenshot({ path: test.info().outputPath('render-page-phone.png') })
    await viewer.page.getByRole('link', { name: 'View code' }).tap()
    await expectDashboardCode(viewer.page)
  } finally {
    await viewer.close()
  }
})
