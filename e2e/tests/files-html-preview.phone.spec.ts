import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import {
  expectAllBlocked,
  expectProbeBlocked,
  FRESH_STORAGE,
  HTML_MOD_OFF_NOTE,
  outsideRequests,
  PAGE_CONSOLE_ERRORS,
  PAGE_VIOLATIONS,
  previewFrame,
  previewStatus,
  SCRIPTS_OFF_NOTE,
  seedHtmlAgent,
  startFakeWeb,
  turnOnScripts,
} from './support/html-pages.js'
import { longestTask, seedLongLineAgent, watchLongTasks } from './support/long-lines.js'
import { setModEnabled } from './support/mods.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.use({ allowedCspViolations: PAGE_VIOLATIONS, allowedConsoleErrors: PAGE_CONSOLE_ERRORS })

const openFiles = async (page: Page) => {
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
}

test('an HTML file previews with scripts off on a phone, and Scripts and Source are a tap away', async ({
  page,
  baseURL,
}) => {
  const web = await startFakeWeb()
  try {
    const outside = outsideRequests(page, baseURL ?? '')
    const { id } = await seedHtmlAgent(web.url)
    await page.goto(`/#agents/${id}`)
    await openFiles(page)
    const panel = filesPanel(page)

    await openViewerFile(page, 'status.html')
    const status = previewFrame(page, 'status.html')
    await expect(status.locator('#out')).toHaveText('Waiting for the script')
    await expect(panel.getByText(SCRIPTS_OFF_NOTE)).toBeVisible()
    await turnOnScripts(page, 'status.html', 'tap')
    await expect(status.locator('#out')).toHaveText('Rendered by the page script')
    const frame = await panel.locator('iframe').boundingBox()
    const viewport = page.viewportSize()
    expect(frame?.width).toBe(viewport?.width)
    expect(frame?.height ?? 0).toBeGreaterThan((viewport?.height ?? 0) / 2)
    await expectFitsPhone(page, 'an HTML preview')

    await panel.getByRole('button', { name: 'Source', exact: true }).tap()
    await expect(panel.locator('iframe')).toHaveCount(0)
    await expect(panel.getByText("document.getElementById('out')")).toBeVisible()
    await expectFitsPhone(page, 'an HTML file as source')

    await openViewerFile(page, 'probe.html')
    await turnOnScripts(page, 'probe.html', 'tap')
    await expectProbeBlocked(previewFrame(page, 'probe.html'))

    await openViewerFile(page, 'storage.html')
    const storage = previewFrame(page, 'storage.html')
    await turnOnScripts(page, 'storage.html', 'tap')
    await expect(storage.locator('#out')).toHaveText(FRESH_STORAGE)
    await panel.getByRole('button', { name: 'Scripts', exact: true }).tap()
    await turnOnScripts(page, 'storage.html', 'tap')
    await expect(storage.locator('#out')).toHaveText(FRESH_STORAGE)
    expect(await page.evaluate(() => localStorage.getItem('fm-graph-settings'))).toBeNull()

    await openViewerFile(page, 'remote.html')
    const remote = previewFrame(page, 'remote.html')
    await expect(remote.locator('#state')).toHaveText('Waiting')
    await turnOnScripts(page, 'remote.html', 'tap')
    await expect(remote.locator('#state')).toHaveText('No popup')
    await remote.locator('#away').tap()
    await expect(panel.locator('iframe[title="Preview of remote.html"]')).toBeVisible()
    await expectAllBlocked(outside, web.url)
    expect(web.hits).toEqual([])
  } finally {
    await web.close()
  }
})

test('a page with one huge line previews on a phone without stalling', async ({ page }) => {
  await watchLongTasks(page)
  const { id } = await seedLongLineAgent()
  await page.goto(`/#agents/${id}`)
  await openFiles(page)

  await openViewerFile(page, 'long-line.html')
  await expect(previewFrame(page, 'long-line.html').getByText('Paragraph 168 of the report.')).toBeAttached()
  expect(await longestTask(page)).toBeLessThan(1_000)
  await expectFitsPhone(page, 'a preview of a huge line')
})

test('with the HTML preview mod off a phone shows an HTML file as source, and Turn on brings the preview back', async ({
  page,
  request,
}) => {
  const { id } = await seedHtmlAgent('http://127.0.0.1:9')
  await page.goto(`/#agents/${id}`)
  await openFiles(page)
  const panel = filesPanel(page)
  await openViewerFile(page, 'status.html')
  await expect(previewFrame(page, 'status.html').locator('#out')).toHaveText('Waiting for the script')

  await setModEnabled(request, 'html-preview', false)
  try {
    await page.reload()
    await openFiles(page)
    await openViewerFile(page, 'status.html')
    await expect(panel.getByText("document.getElementById('out')")).toBeVisible()
    await expect(panel.locator('iframe')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Scripts', exact: true })).toHaveCount(0)
    const note = panel.getByRole('note').filter({ hasText: HTML_MOD_OFF_NOTE })
    await expect(note).toBeVisible()
    await expectFitsPhone(page, 'an HTML file with the HTML preview mod off')
    expect(await previewStatus(request, id, 'status.html')).toBe(403)

    await note.getByRole('button', { name: 'Turn on' }).tap()
    await page.getByRole('dialog', { name: 'Confirm' }).getByRole('button', { name: 'Turn on' }).tap()
    await expect(previewFrame(page, 'status.html').locator('#out')).toHaveText('Waiting for the script')
    await turnOnScripts(page, 'status.html', 'tap')
    await expect(previewFrame(page, 'status.html').locator('#out')).toHaveText('Rendered by the page script')
    await expectFitsPhone(page, 'an HTML preview turned back on')
  } finally {
    await setModEnabled(request, 'html-preview', true)
  }
})
