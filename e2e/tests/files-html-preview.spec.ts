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
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.use({ allowedCspViolations: PAGE_VIOLATIONS, allowedConsoleErrors: PAGE_CONSOLE_ERRORS })

test('an HTML file previews with scripts off, and with Scripts on still reaches neither Seti nor the web', async ({
  page,
  baseURL,
}) => {
  const web = await startFakeWeb()
  try {
    const outside = outsideRequests(page, baseURL ?? '')
    const { id } = await seedHtmlAgent(web.url)
    await page.goto(`/#agents/${id}`)
    await page.evaluate(() => {
      document.cookie = 'seti-probe=visible; path=/'
      localStorage.setItem('seti-probe', 'visible')
    })
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const panel = filesPanel(page)

    await openViewerFile(page, 'status.html')
    const status = previewFrame(page, 'status.html')
    await expect(status.getByRole('heading', { name: 'Deploy status' })).toBeVisible()
    await expect(status.locator('#out')).toHaveText('Waiting for the script')
    await expect(panel.getByText(SCRIPTS_OFF_NOTE)).toBeVisible()
    await turnOnScripts(page, 'status.html', 'click')
    await expect(status.locator('#out')).toHaveText('Rendered by the page script')
    await expect(panel.getByText("Previewed offline: web links, remote scripts and images don't load.")).toBeVisible()
    await expect(panel.getByRole('link', { name: 'Download status.html' })).toBeVisible()

    await panel.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(panel.locator('iframe')).toHaveCount(0)
    await expect(panel.getByText("document.getElementById('out')")).toBeVisible()
    await panel.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(status.locator('#out')).toHaveText('Rendered by the page script')
    await openViewerFile(page, 'status.html')
    await expect(status.locator('#out')).toHaveText('Rendered by the page script')

    await openViewerFile(page, 'probe.html')
    await turnOnScripts(page, 'probe.html', 'click')
    await expectProbeBlocked(previewFrame(page, 'probe.html'))

    await openViewerFile(page, 'storage.html')
    const storage = previewFrame(page, 'storage.html')
    await turnOnScripts(page, 'storage.html', 'click')
    await expect(storage.locator('#out')).toHaveText(FRESH_STORAGE)
    await panel.getByRole('button', { name: 'Scripts', exact: true }).click()
    await turnOnScripts(page, 'storage.html', 'click')
    await expect(storage.locator('#out')).toHaveText(FRESH_STORAGE)
    expect(await page.evaluate(() => localStorage.getItem('fm-graph-settings'))).toBeNull()

    await openViewerFile(page, 'remote.html')
    const remote = previewFrame(page, 'remote.html')
    await expect(remote.locator('#state')).toHaveText('Waiting')
    await turnOnScripts(page, 'remote.html', 'click')
    await expect(remote.locator('#state')).toHaveText('No popup')
    await remote.locator('#away').click()
    await expect(panel.locator('iframe[title="Preview of remote.html"]')).toBeVisible()
    await expectAllBlocked(outside, web.url)
    expect(web.hits).toEqual([])
    expect(page.context().pages()).toHaveLength(1)
  } finally {
    await web.close()
  }
})

test('a page with one huge line previews without stalling the viewer', async ({ page }) => {
  await watchLongTasks(page)
  const { id } = await seedLongLineAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()

  await openViewerFile(page, 'long-line.html')
  await expect(previewFrame(page, 'long-line.html').getByText('Paragraph 168 of the report.')).toBeVisible()
  expect(await longestTask(page)).toBeLessThan(1_000)
})

test('with the HTML preview mod off an HTML file opens as source and no page is served, until Turn on', async ({
  page,
  request,
}) => {
  const { id } = await seedHtmlAgent('http://127.0.0.1:9')
  const long = await seedLongLineAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await openViewerFile(page, 'status.html')
  await expect(previewFrame(page, 'status.html').getByRole('heading', { name: 'Deploy status' })).toBeVisible()
  await turnOnScripts(page, 'status.html', 'click')

  await setModEnabled(request, 'html-preview', false)
  try {
    expect(await previewStatus(request, id, 'status.html')).toBe(403)
    await page.goto(`/#agents/${long.id}`)
    await page.reload()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await openViewerFile(page, 'long-line.html')
    await expect(panel.getByText('A line is too long to colour; showing plain text.')).toBeVisible()
    await expect(panel.locator('iframe')).toHaveCount(0)

    await page.goto(`/#agents/${id}`)
    await page.reload()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await openViewerFile(page, 'status.html')
    await expect(panel.getByText("document.getElementById('out')")).toBeVisible()
    await expect(panel.locator('iframe')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Scripts', exact: true })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Source', exact: true })).toHaveCount(0)
    const note = panel.getByRole('note').filter({ hasText: HTML_MOD_OFF_NOTE })
    await note.getByRole('button', { name: 'Turn on' }).click()
    await page.getByRole('dialog', { name: 'Confirm' }).getByRole('button', { name: 'Turn on' }).click()
    await expect(previewFrame(page, 'status.html').locator('#out')).toHaveText('Waiting for the script')
    await expect(note).toHaveCount(0)
    await turnOnScripts(page, 'status.html', 'click')
    await expect(previewFrame(page, 'status.html').locator('#out')).toHaveText('Rendered by the page script')
    expect(await previewStatus(request, id, 'status.html')).toBe(200)
  } finally {
    await setModEnabled(request, 'html-preview', true)
  }
})
