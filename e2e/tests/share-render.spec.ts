import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import {
  CODE_LINE,
  expectDashboardCode,
  expectRenderedDashboard,
  RENDER_LINE,
  seedDashboard,
} from './support/render-dialog.js'
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

test('an HTML file renders as its page by default, and turning Render off shows its code', async ({
  page,
  browser,
}) => {
  const { id, dir } = await seedShareAgent()
  seedDashboard(dir)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()

  const notes = await openShareDialog(page, 'notes.md')
  await expect(notes.getByRole('switch', { name: /Link preview/ })).toBeVisible()
  await expect(notes.getByRole('switch', { name: /Render/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const dialog = await openShareDialog(page, 'dashboard.html')
  const render = dialog.getByRole('switch', { name: /Render/ })
  await expect(render).toBeChecked()
  await expect(dialog.getByText(RENDER_LINE)).toBeVisible()
  await expect(dialog.getByText(/live/i)).toHaveCount(0)
  await dialog.screenshot({ path: test.info().outputPath('render-dialog.png') })
  await dialog.getByRole('button', { name: 'Create link' }).click()
  const link = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/share\/[A-Za-z0-9_-]{43}$/)
  await expect(dialog.getByRole('switch', { name: /Render/ })).toBeChecked()
  await dialog.screenshot({ path: test.info().outputPath('render-dialog-link.png') })
  const url = await link.inputValue()

  const viewer = await stranger(browser)
  try {
    await viewer.page.goto(url)
    await expectRenderedDashboard(viewer.page)
    await viewer.page.screenshot({ path: test.info().outputPath('render-page.png') })
    await viewer.page.getByRole('link', { name: 'View code' }).click()
    await expect(viewer.page).toHaveURL(`${url}/code`)
    await expectDashboardCode(viewer.page)

    await dialog.getByRole('switch', { name: /Render/ }).click()
    await expect(dialog.getByRole('switch', { name: /Render/ })).not.toBeChecked()
    await expect(dialog.getByText(CODE_LINE)).toBeVisible()
    await viewer.page.goto(url)
    await expectDashboardCode(viewer.page)
    expect((await viewer.page.goto(`${url}/code`))?.status()).toBe(404)
  } finally {
    await viewer.close()
  }
})

test('an HTML file shared with Render off shows its code', async ({ page, browser }) => {
  const { id, dir } = await seedShareAgent()
  seedDashboard(dir)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const dialog = await openShareDialog(page, 'dashboard.html')
  await dialog.getByRole('switch', { name: /Render/ }).click()
  await expect(dialog.getByText(CODE_LINE)).toBeVisible()
  await dialog.getByRole('button', { name: 'Create link' }).click()
  const link = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/share\/[A-Za-z0-9_-]{43}$/)
  await expect(dialog.getByRole('switch', { name: /Render/ })).not.toBeChecked()
  const viewer = await stranger(browser)
  try {
    await viewer.page.goto(await link.inputValue())
    await expectDashboardCode(viewer.page)
  } finally {
    await viewer.close()
  }
})
