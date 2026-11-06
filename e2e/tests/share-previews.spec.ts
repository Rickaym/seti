import type { Page } from '@playwright/test'
import type { Envelope, ShareList } from '@seti/shared'
import { expect, test } from './support/fixtures.js'
import { openShare, seedShareAgent, seedShareMedia, setSharing, shareByApi, stranger } from './support/shares.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.describe.configure({ timeout: 90_000 })

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

const naturalWidth = async (page: Page, name: string) =>
  page.getByRole('img', { name, exact: true }).evaluate((img: HTMLImageElement) => img.naturalWidth)

/** Drags across the first three lines of page 1 and returns what the browser would copy. */
async function dragSelect(page: Page): Promise<string> {
  const lines = page.locator('figure.page').first().locator('.tl span')
  await lines.first().scrollIntoViewIfNeeded()
  const [from, to] = [await lines.nth(0).boundingBox(), await lines.nth(2).boundingBox()]
  if (from === null || to === null) {
    throw new Error('The text layer has no boxes')
  }
  const start = { x: from.x + 1, y: from.y + from.height / 2 }
  const end = { x: to.x + to.width - 1, y: to.y + to.height / 2 }
  // Playwright's mouse waits on a drag check that a page without script never answers.
  const cdp = await page.context().newCDPSession(page)
  const mouse = async (
    type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
    at: { x: number; y: number },
    buttons: number,
  ) => cdp.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', buttons, clickCount: 1 })
  await mouse('mousePressed', start, 1)
  for (let step = 1; step <= 8; step += 1) {
    const t = step / 8
    await mouse('mouseMoved', { x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) }, 1)
  }
  await mouse('mouseReleased', end, 0)
  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

test('a shared PDF shows its pages as images with selectable text, no script and the policy intact', async ({
  page,
  browser,
}) => {
  const { id } = await seedShareAgent()
  const dialog = await openShareDialog(page, id, 'report.pdf')
  await dialog.getByRole('button', { name: 'Create link' }).click()
  const link = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/share\/[A-Za-z0-9_-]{43}$/, { timeout: 60_000 })
  await expect(dialog.getByTestId('share-preview')).toHaveText('PDF, 3 pages')
  const url = await link.inputValue()

  const viewer = await stranger(browser)
  try {
    expect((await openShare(viewer.page, url)).status()).toBe(200)
    await expect(viewer.page.getByText('Quarterly report')).toBeVisible()
    await expect(viewer.page.getByRole('img', { name: 'Page 1', exact: true })).toBeVisible()
    await expect.poll(async () => naturalWidth(viewer.page, 'Page 1')).toBe(1200)
    await viewer.page.getByRole('img', { name: 'Page 3', exact: true }).scrollIntoViewIfNeeded()
    await expect.poll(async () => naturalWidth(viewer.page, 'Page 3')).toBe(1200)
    await expect(viewer.page.locator('details')).toHaveCount(0)
    await expect(viewer.page.locator('figure.page').nth(1).locator('.tl')).toContainText('Line 3 of page 2')
    const selected = await dragSelect(viewer.page)
    expect(selected).toMatch(/^Page 1 heading\nLine 0 of page 1\nLine 1 of page 1/)
    await viewer.page.screenshot({ path: test.info().outputPath('pdf-selection.png') })
    await expect(viewer.page.locator('script, iframe, object, embed')).toHaveCount(0)
    expect(viewer.errors).toEqual([])

    const image = await viewer.page.request.get(`${url}/p/1`)
    expect(image.headers()['content-type']).toBe('image/webp')
    expect(image.headers()['cross-origin-resource-policy']).toBe('cross-origin')
    expect(image.headers()['content-security-policy']).toContain("img-src 'none'")
    expect((await viewer.page.request.get(`${url}/p/4`)).status()).toBe(404)
    expect((await viewer.page.request.get(`${url}/p/1/x`)).status()).toBe(404)
    const raw = await viewer.page.request.get(`${url}/raw`)
    expect(raw.headers()['cross-origin-resource-policy']).toBe('same-origin')
  } finally {
    await viewer.close()
  }
})

test('an SVG renders as a picture with its source, never as SVG', async ({ browser, request }) => {
  const { id } = await seedShareAgent()
  const url = await shareByApi(request, id, 'logo.svg')
  const viewer = await stranger(browser)
  try {
    await openShare(viewer.page, url)
    await expect.poll(async () => naturalWidth(viewer.page, 'logo.svg')).toBe(240)
    await expect(viewer.page.locator('svg, script')).toHaveCount(0)
    await viewer.page.getByText('View source').click()
    await expect(viewer.page.locator('details pre')).toContainText('<script>document.title="ran"</script>')
    await expect(viewer.page).toHaveTitle('logo.svg')
    expect(viewer.errors).toEqual([])
  } finally {
    await viewer.close()
  }
})

test('a notebook shows its cells, its image output, and HTML output only as text', async ({ browser, request }) => {
  const { id } = await seedShareAgent()
  const url = await shareByApi(request, id, 'analysis.ipynb')
  const viewer = await stranger(browser)
  try {
    await openShare(viewer.page, url)
    await expect(viewer.page.getByRole('heading', { name: 'Analysis', exact: true })).toBeVisible()
    await expect(viewer.page.locator('pre.code')).toContainText('total = sum(range(10))')
    await expect(viewer.page.getByText('45', { exact: true })).toBeVisible()
    await expect(viewer.page.getByText('<script>document.title="ran"</script>')).toBeVisible()
    await expect.poll(async () => naturalWidth(viewer.page, 'Output image')).toBe(32)
    await expect(viewer.page.locator('script')).toHaveCount(0)
    await expect(viewer.page).toHaveTitle('analysis.ipynb')
  } finally {
    await viewer.close()
  }
})

test('a shared Word document shows its pages with their text, made by LibreOffice in the sandbox', async ({
  browser,
  request,
}) => {
  const { id } = await seedShareAgent()
  const url = await shareByApi(request, id, 'memo.docx')
  const viewer = await stranger(browser)
  try {
    await openShare(viewer.page, url)
    await expect(viewer.page.getByText('Word document, 1 page', { exact: true })).toBeVisible()
    await expect.poll(async () => naturalWidth(viewer.page, 'Page 1')).toBe(1200)
    await expect(viewer.page.locator('.tl')).toContainText('Ship the media previews on Friday.')
    await expect(viewer.page.locator('script, iframe, object, embed, video, audio')).toHaveCount(0)
    expect(viewer.errors).toEqual([])
  } finally {
    await viewer.close()
  }
})

test('a shared video and MP3 play from byte ranges of their download, each page counted once', async ({
  browser,
  request,
}) => {
  const { id, dir } = await seedShareAgent()
  seedShareMedia(dir)
  const clip = await shareByApi(request, id, 'clip.mp4')
  const tone = await shareByApi(request, id, 'tone.mp3')
  const viewer = await stranger(browser)
  const fetched: number[] = []
  viewer.page.on('response', (res) => {
    if (res.url() === `${clip}/raw`) {
      fetched.push(res.status())
    }
  })
  try {
    await openShare(viewer.page, clip, { media: true })
    await expect(viewer.page.getByText('Video, 0:01, 64 \u00d7 48', { exact: true })).toBeVisible()
    const video = viewer.page.getByLabel('clip.mp4', { exact: true })
    await expect.poll(async () => video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(64)
    const state = await video.evaluate((el: HTMLVideoElement) => [el.paused, el.controls, el.autoplay, el.preload])
    expect(state).toEqual([true, true, false, 'metadata'])
    expect(await video.getAttribute('poster')).toMatch(/\/p\/1$/)
    expect(fetched).toContain(206)

    await openShare(viewer.page, tone, { media: true })
    const audio = viewer.page.getByLabel('tone.mp3', { exact: true })
    await expect.poll(async () => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeGreaterThan(0.5)
    await expect(viewer.page.locator('script')).toHaveCount(0)
    expect(viewer.errors).toEqual([])

    const listed = (await (await request.get('/api/shares')).json()) as Envelope<ShareList>
    const views = (file: string) => listed.data.shares.find((share) => share.path === `docs/${file}`)?.view_count
    expect([views('clip.mp4'), views('tone.mp3')]).toEqual([1, 1])

    const part = await viewer.page.request.get(`${clip}/raw`, { headers: { Range: 'bytes=0-99' } })
    expect(part.status()).toBe(206)
    expect(part.headers()['content-range']).toBe('bytes 0-99/2860')
    expect(part.headers()['content-type']).toBe('video/mp4')
    expect(part.headers()['cross-origin-resource-policy']).toBe('cross-origin')
    expect(await part.body()).toHaveLength(100)
    const past = await viewer.page.request.get(`${clip}/raw`, { headers: { Range: 'bytes=9000-' } })
    expect(past.status()).toBe(416)
    expect(past.headers()['content-range']).toBe('bytes */2860')
  } finally {
    await viewer.close()
  }
})

test('a link pasted in Slack unfurls with its card, counted as a link preview and not a view', async ({
  page,
  request,
}) => {
  const { id } = await seedShareAgent()
  const url = await shareByApi(request, id, 'report.pdf')
  const slack = { 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' }
  const html = await (await request.get(url, { headers: slack })).text()
  const meta = (key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html)?.[1]
  expect(meta('og:title')).toBe('report.pdf')
  expect(meta('og:description')).toMatch(/^PDF, 3 pages, [\d.]+ KB$/)
  expect(meta('og:url')).toBe(url)
  expect(meta('twitter:card')).toBe('summary_large_image')
  const card = await request.get(meta('og:image') ?? '', { headers: slack })
  expect(card.status()).toBe(200)
  expect(card.headers()['content-type']).toBe('image/png')
  const png = await card.body()
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])

  const dialog = await openShareDialog(page, id, 'report.pdf')
  await expect(dialog.getByTestId('share-facts')).toContainText('Views0')
  await expect(dialog.getByTestId('share-unfurls')).toContainText('1 by Slack')

  await dialog.getByRole('switch', { name: /Link preview/ }).click()
  await expect(dialog.getByRole('switch', { name: /Link preview/ })).not.toBeChecked()
  const plain = await (await request.get(url, { headers: slack })).text()
  expect(plain).toContain('<meta property="og:title" content="report.pdf">')
  expect(plain).not.toContain('og:image')
  expect(plain).not.toContain('og:description')
  expect((await request.get(`${url}/card.png`)).status()).toBe(404)
})
