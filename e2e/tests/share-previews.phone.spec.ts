import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { openShare, seedShareAgent, seedShareMedia, setSharing, shareByApi, stranger } from './support/shares.js'

test.describe.configure({ timeout: 90_000 })

test.beforeEach(async ({ request }) => {
  await setSharing(request, true)
})

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/shares/revoke-all', { data: {} })).ok()).toBe(true)
  await setSharing(request, false)
})

const pageOverflow = async (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test('a wide CSV reads as a table that scrolls inside itself on a phone', async ({ browser, request, viewport }) => {
  const { id } = await seedShareAgent()
  const url = await shareByApi(request, id, 'numbers.csv')
  const viewer = await stranger(browser, viewport ?? { width: 390, height: 844 })
  try {
    await openShare(viewer.page, url)
    await expect(viewer.page.getByText('Table, 1,500 rows, 12 columns, first 1,000 rows shown')).toBeVisible()
    await expect(viewer.page.locator('tbody tr')).toHaveCount(1000)
    await expect(viewer.page.locator('tbody td').first()).toHaveText('=SUM(A0)')
    await expect(viewer.page.locator('tbody td').nth(1)).toHaveText('<b>0</b>')
    expect(await pageOverflow(viewer.page)).toBeLessThanOrEqual(0)
    const scroller = viewer.page.locator('div.table')
    const wide = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(wide).toBe(true)
    await scroller.evaluate((el) => {
      el.scrollTo({ top: 2000 })
    })
    const header = viewer.page.locator('thead th').first()
    const [box, frame] = [await header.boundingBox(), await scroller.boundingBox()]
    expect(Math.abs((box?.y ?? 0) - (frame?.y ?? 0))).toBeLessThan(4)
    await expect(viewer.page.locator('script')).toHaveCount(0)
  } finally {
    await viewer.close()
  }
})

test('a shared video fits a phone, its player loading under the policy', async ({ browser, request, viewport }) => {
  const { id, dir } = await seedShareAgent()
  seedShareMedia(dir)
  const url = await shareByApi(request, id, 'clip.mp4')
  const viewer = await stranger(browser, viewport ?? { width: 390, height: 844 })
  try {
    await openShare(viewer.page, url, { media: true })
    const video = viewer.page.getByLabel('clip.mp4', { exact: true })
    await expect.poll(async () => video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(64)
    expect(await video.evaluate((el: HTMLVideoElement) => el.playsInline)).toBe(true)
    const box = await video.boundingBox()
    expect(box?.width ?? 0).toBeLessThanOrEqual(viewer.page.viewportSize()?.width ?? 0)
    expect(await pageOverflow(viewer.page)).toBeLessThanOrEqual(0)
    expect(viewer.errors).toEqual([])
  } finally {
    await viewer.close()
  }
})

function near(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(2)
}

test('a PDF fits a phone, its text laid over its pages under the policy', async ({ browser, request, viewport }) => {
  const { id } = await seedShareAgent()
  const url = await shareByApi(request, id, 'report.pdf')
  const viewer = await stranger(browser, viewport ?? { width: 390, height: 844 })
  try {
    await openShare(viewer.page, url)
    const first = viewer.page.getByRole('img', { name: 'Page 1', exact: true })
    await expect.poll(async () => first.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200)
    expect(await pageOverflow(viewer.page)).toBeLessThanOrEqual(0)
    const layer = viewer.page.locator('figure.page').first().locator('.tl')
    const [image, over] = [await first.boundingBox(), await layer.boundingBox()]
    const heading = await layer.getByText('Page 1 heading', { exact: true }).boundingBox()
    if (image === null || over === null || heading === null) {
      throw new Error('The page or its text layer has no box')
    }
    near(over.x, image.x + 1)
    near(over.width, image.width - 2)
    near(over.height, image.height - 2)
    near(heading.x, over.x + (72 / 612) * over.width)
    near(heading.y, over.y + (54.768 / 792) * over.height)
    near(heading.width, ((240.12 - 72) / 612) * over.width)
    expect(await layer.evaluate((el) => getComputedStyle(el).touchAction)).toBe('auto')
    const selected = await layer.evaluate((el) => {
      const range = document.createRange()
      range.setStart(el, 0)
      range.setEnd(el, 3)
      window.getSelection()?.addRange(range)
      return window.getSelection()?.toString()
    })
    expect(selected).toBe('Page 1 heading\nLine 0 of page 1')
    await viewer.page.screenshot({ path: test.info().outputPath('pdf-selection.png') })
    expect(viewer.errors).toEqual([])
  } finally {
    await viewer.close()
  }
})
