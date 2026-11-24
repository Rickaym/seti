import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { expectLiveDashboard, expectStaticDashboard, LIVE_LINE, seedDashboard } from './support/live-dialog.js'
import { seedShareAgent, setSharing, stranger } from './support/shares.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.beforeEach(async ({ request }) => {
  await setSharing(request, true)
})

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/shares/revoke-all', { data: {} })).ok()).toBe(true)
  await setSharing(request, false)
})

async function openShareDialog(page: Page, file: string) {
  await openViewerFile(page, file)
  await filesPanel(page).getByTestId('viewer-header').getByRole('button', { name: 'Share' }).click()
  return page.getByRole('dialog', { name: `Share ${file}` })
}

test('an HTML file is shared as a live page, which a visitor can switch to its static view', async ({
  page,
  browser,
}) => {
  const { id, dir } = await seedShareAgent()
  seedDashboard(dir)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()

  const notes = await openShareDialog(page, 'notes.md')
  await expect(notes.getByRole('switch', { name: /Link preview/ })).toBeVisible()
  await expect(notes.getByRole('switch', { name: /Live/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const dialog = await openShareDialog(page, 'dashboard.html')
  const live = dialog.getByRole('switch', { name: /Live/ })
  await expect(live).not.toBeChecked()
  await expect(dialog.getByText(LIVE_LINE)).toBeVisible()
  await live.click()
  await expect(live).toBeChecked()
  await dialog.screenshot({ path: test.info().outputPath('live-dialog.png') })
  await dialog.getByRole('button', { name: 'Create link' }).click()
  const link = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/share\/[A-Za-z0-9_-]{43}$/)
  await expect(dialog.getByRole('switch', { name: /Live/ })).toBeChecked()
  await dialog.screenshot({ path: test.info().outputPath('live-dialog-link.png') })
  const url = await link.inputValue()

  const viewer = await stranger(browser)
  try {
    await viewer.page.goto(url)
    await expectLiveDashboard(viewer.page)
    await viewer.page.screenshot({ path: test.info().outputPath('live-page.png') })
    await viewer.page.getByRole('link', { name: 'Static view' }).click()
    await expect(viewer.page).toHaveURL(`${url}/static`)
    await expectStaticDashboard(viewer.page)

    await dialog.getByRole('switch', { name: /Live/ }).click()
    await expect(dialog.getByRole('switch', { name: /Live/ })).not.toBeChecked()
    await viewer.page.goto(url)
    await expectStaticDashboard(viewer.page)
    expect((await viewer.page.goto(`${url}/static`))?.status()).toBe(404)
  } finally {
    await viewer.close()
  }
})
