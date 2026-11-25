import { expect, test } from './support/fixtures.js'
import { expectLiveDashboard, expectStaticDashboard, LIVE_LINE, seedDashboard } from './support/live-dialog.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { seedShareAgent, setSharing, stranger } from './support/shares.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.beforeEach(async ({ request }) => {
  await setSharing(request, true)
})

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/shares/revoke-all', { data: {} })).ok()).toBe(true)
  await setSharing(request, false)
})

test('a phone shares an HTML file as a live page that fits the phone', async ({ page, browser, viewport }) => {
  const { id, dir } = await seedShareAgent()
  seedDashboard(dir)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  await openViewerFile(page, 'dashboard.html')
  await filesPanel(page).getByTestId('viewer-header').getByRole('button', { name: 'Share' }).tap()
  const dialog = page.getByRole('dialog', { name: 'Share dashboard.html' })

  const live = dialog.getByRole('switch', { name: /Live/ })
  await expect(dialog.getByText(LIVE_LINE)).toBeVisible()
  await dialog.getByText(LIVE_LINE).tap()
  await expect(live).toBeChecked()
  await expectTouchTarget(dialog.locator('label').filter({ hasText: LIVE_LINE }))
  await expectFitsPhone(page, 'the share dialog with Live')
  await page.screenshot({ path: test.info().outputPath('live-dialog-phone.png') })
  await dialog.getByRole('button', { name: 'Create link' }).tap()
  const link = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/share\/[A-Za-z0-9_-]{43}$/)
  const url = await link.inputValue()

  const viewer = await stranger(browser, viewport ?? { width: 390, height: 844 })
  try {
    await viewer.page.goto(url)
    await expectLiveDashboard(viewer.page)
    const overflow = await viewer.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await viewer.page.screenshot({ path: test.info().outputPath('live-page-phone.png') })
    await viewer.page.getByRole('link', { name: 'Static view' }).tap()
    await expectStaticDashboard(viewer.page)
  } finally {
    await viewer.close()
  }
})
