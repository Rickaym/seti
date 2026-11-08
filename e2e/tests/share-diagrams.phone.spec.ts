import type { Locator } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { openShare, seedShareAgent, seedShareDiagrams, setSharing, stranger } from './support/shares.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.describe.configure({ timeout: 90_000 })

test.beforeEach(async ({ request }) => {
  await setSharing(request, true)
})

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/shares/revoke-all', { data: {} })).ok()).toBe(true)
  await setSharing(request, false)
})

const widthOf = async (image: Locator) => image.evaluate((img: HTMLImageElement) => img.getBoundingClientRect().width)

test('a phone shares a Markdown diagram, and its zoom scrolls inside the frame on a phone', async ({
  page,
  browser,
  viewport,
}) => {
  const { id, dir } = await seedShareAgent()
  seedShareDiagrams(dir)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  await openViewerFile(page, 'diagrams.md')
  await filesPanel(page).getByTestId('viewer-header').getByRole('button', { name: 'Share' }).tap()
  const dialog = page.getByRole('dialog', { name: 'Share diagrams.md' })
  await dialog.getByRole('button', { name: 'Create link' }).tap()
  const link = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/share\/[A-Za-z0-9_-]{43}$/, { timeout: 60_000 })
  const url = await link.inputValue()

  const viewer = await stranger(browser, viewport ?? { width: 390, height: 844 })
  try {
    await openShare(viewer.page, url)
    const figure = viewer.page.locator('figure.diagram')
    const image = figure.getByRole('img', { name: 'mermaid diagram' })
    await expect.poll(async () => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    const frame = figure.locator('.frame')
    const room = await frame.evaluate((el) => el.clientWidth)
    expect(await widthOf(image)).toBeLessThanOrEqual(room + 0.5)
    const label = figure.getByText('200%', { exact: true })
    expect((await label.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(30)
    await label.tap()
    await expect.poll(async () => widthOf(image)).toBeGreaterThan(room)
    expect(await frame.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    const overflow = await viewer.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await figure.getByText('Fit', { exact: true }).tap()
    await expect.poll(async () => widthOf(image)).toBeLessThanOrEqual(room + 0.5)
    await viewer.page.screenshot({ path: test.info().outputPath('diagram-phone.png') })
    expect(viewer.errors).toEqual([])
  } finally {
    await viewer.close()
  }
})
