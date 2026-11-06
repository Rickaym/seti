import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { openShare, seedShareAgent, setSharing, shareByApi, stranger } from './support/shares.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.beforeEach(async ({ request }) => {
  await setSharing(request, true)
})

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/shares/revoke-all', { data: {} })).ok()).toBe(true)
  await setSharing(request, false)
})

test('a phone shares a file from Files, and the link reads well on a phone', async ({ page, browser, viewport }) => {
  const { id } = await seedShareAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  await openViewerFile(page, 'notes.md')

  const share = filesPanel(page).getByTestId('viewer-header').getByRole('button', { name: 'Share' })
  expect((await share.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await share.tap()
  const dialog = page.getByRole('dialog', { name: 'Share notes.md' })
  await expectFitsPhone(page, 'the share dialog')
  await dialog.getByRole('button', { name: 'Create link' }).tap()
  const link = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/share\/[A-Za-z0-9_-]{43}$/)
  await expectFitsPhone(page, 'the share dialog with its link')
  const url = await link.inputValue()

  const viewer = await stranger(browser, viewport ?? { width: 390, height: 844 })
  try {
    await openShare(viewer.page, url)
    await expect(viewer.page.getByRole('img', { name: 'chart' })).toBeVisible()
    const overflow = await viewer.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await expect(viewer.page.locator('script')).toHaveCount(0)
  } finally {
    await viewer.close()
  }
})

test('a phone revokes a share from Settings', async ({ page, browser, request }) => {
  const { id } = await seedShareAgent()
  const url = await shareByApi(request, id, 'page.html')
  await page.goto('/#settings/sharing')
  const row = page.getByTestId('share-row').filter({ hasText: 'docs/page.html' })
  await expect(row).toBeVisible()
  await expectFitsPhone(page, 'the sharing settings')
  await row.getByRole('button', { name: 'Revoke' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).tap()
  await expect(row).toContainText('revoked')
  const viewer = await stranger(browser)
  try {
    expect((await openShare(viewer.page, url)).status()).toBe(404)
  } finally {
    await viewer.close()
  }
})
