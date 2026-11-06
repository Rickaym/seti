import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { openShare, seedShareAgent, setSharing, shareByApi, stranger } from './support/shares.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.use({ allowedHttpStatuses: [409] })

test.beforeEach(async ({ request }) => {
  await setSharing(request, true)
})

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/shares/revoke-all', { data: {} })).ok()).toBe(true)
  await setSharing(request, false)
})

async function openShareDialog(page: Page, id: string, file: string) {
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await openViewerFile(page, file)
  await filesPanel(page).getByTestId('viewer-header').getByRole('button', { name: 'Share' }).click()
  return page.getByRole('dialog', { name: `Share ${file}` })
}

test('shares a Markdown file from Files, and the link opens for anyone with its image and no script', async ({
  page,
  browser,
}) => {
  const { id } = await seedShareAgent()
  const dialog = await openShareDialog(page, id, 'notes.md')
  await expect(dialog.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: '30 days' }).click()
  await dialog.getByRole('button', { name: 'Create link' }).click()
  const link = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/share\/[A-Za-z0-9_-]{43}$/)
  await expect(dialog).toContainText('Seti keeps no copy of the link and cannot show it again')
  await expect(dialog.getByTestId('share-facts')).toContainText('Views0')
  const url = await link.inputValue()

  const viewer = await stranger(browser)
  try {
    const res = await openShare(viewer.page, url)
    expect(res.status()).toBe(200)
    await expect(viewer.page.getByRole('heading', { name: 'notes.md' })).toBeVisible()
    await expect(viewer.page.getByRole('heading', { name: 'Launch notes' })).toBeVisible()
    await expect(viewer.page.locator('script')).toHaveCount(0)
    const chart = viewer.page.getByRole('img', { name: 'chart' })
    await expect(chart).toBeVisible()
    await expect.poll(async () => chart.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(32)
    const download = viewer.page.waitForEvent('download')
    await viewer.page.getByRole('link', { name: 'Download' }).click()
    expect((await download).suggestedFilename()).toBe('notes.md')
    expect(viewer.errors).toEqual([])
  } finally {
    await viewer.close()
  }

  await page.keyboard.press('Escape')
  await filesPanel(page).getByTestId('viewer-header').getByRole('button', { name: 'Share' }).click()
  const again = page.getByRole('dialog', { name: 'Share notes.md' })
  await expect(again.getByTestId('share-facts')).toContainText('Views2')
  await expect(again.getByRole('textbox', { name: 'Share link' })).toHaveCount(0)
})

test('an HTML file shows as source, and Revoke makes its link a 404', async ({ page, browser, request }) => {
  const { id } = await seedShareAgent()
  const url = await shareByApi(request, id, 'page.html')
  const viewer = await stranger(browser)
  try {
    await openShare(viewer.page, url)
    await expect(viewer.page.locator('pre')).toContainText('<script>document.title = "ran"</script>')
    await expect(viewer.page.locator('script')).toHaveCount(0)
    await expect(viewer.page).toHaveTitle('page.html')

    const dialog = await openShareDialog(page, id, 'page.html')
    await dialog.getByRole('button', { name: 'Revoke' }).click()
    await page
      .getByRole('dialog')
      .filter({ hasText: 'Revoke this link?' })
      .getByRole('button', { name: 'Revoke' })
      .click()
    await expect(dialog.getByRole('button', { name: 'Create link' })).toBeVisible()

    const gone = await openShare(viewer.page, url)
    expect(gone.status()).toBe(404)
    await expect(viewer.page.locator('body')).toHaveText('Not found')
  } finally {
    await viewer.close()
  }
})

test('a file the secret scan flags names its lines, and shares only on Share anyway', async ({ page }) => {
  const { id } = await seedShareAgent()
  const dialog = await openShareDialog(page, id, 'leaky.txt')
  await dialog.getByRole('button', { name: 'Create link' }).click()
  await expect(dialog.getByRole('list', { name: 'Findings' })).toHaveText('Line 2: access token')
  await expect(dialog).not.toContainText('ghp_')
  await dialog.getByRole('button', { name: 'Share anyway' }).click()
  await expect(dialog.getByRole('textbox', { name: 'Share link' })).toHaveValue(/\/share\//)
})

test('Update republishes the same link with the file as it is now', async ({ page, browser, request }) => {
  const { id, dir } = await seedShareAgent()
  const url = await shareByApi(request, id, 'notes.md')
  fs.writeFileSync(path.join(dir, 'docs', 'notes.md'), '# Launch notes, take two\n')
  const dialog = await openShareDialog(page, id, 'notes.md')
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog.getByTestId('share-facts')).toContainText('Version 2')
  const viewer = await stranger(browser)
  try {
    await openShare(viewer.page, url)
    await expect(viewer.page.getByRole('heading', { name: 'Launch notes, take two' })).toBeVisible()
  } finally {
    await viewer.close()
  }
})

test('Settings lists shares, revokes them all, and the switch turns sharing off', async ({
  page,
  browser,
  request,
}) => {
  const { id, title } = await seedShareAgent()
  const url = await shareByApi(request, id, 'notes.md')
  await shareByApi(request, id, 'page.html')
  const viewer = await stranger(browser)
  try {
    await openShare(viewer.page, url)
    await page.goto('/#settings/sharing')
    const sharing = page.getByRole('switch', { name: 'Allow sharing' })
    await expect(sharing).toBeChecked()
    const rows = page.getByTestId('share-row').filter({ hasText: title })
    await expect(rows.filter({ hasText: 'docs/notes.md' })).toContainText('1 view')
    await expect(rows.filter({ hasText: 'docs/page.html' })).toContainText('0 views')

    await page.getByRole('button', { name: 'Revoke all' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke all' }).click()
    await expect(rows.filter({ hasText: 'docs/notes.md' })).toContainText('revoked')
    await expect(rows.getByRole('button', { name: 'Revoke' })).toHaveCount(0)
    expect((await openShare(viewer.page, url)).status()).toBe(404)

    await sharing.click()
    await expect(sharing).not.toBeChecked()
    const dialog = await openShareDialog(page, id, 'notes.md')
    await expect(dialog).toContainText('Sharing is off')
    await dialog.getByRole('link', { name: 'Settings, Sharing' }).click()
    await expect(page.getByRole('switch', { name: 'Allow sharing' })).toBeVisible()
  } finally {
    await viewer.close()
  }
})
