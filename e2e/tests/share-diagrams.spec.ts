import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { resetPreviews, setPreviewFormat } from './support/mods.js'
import { openShare, seedShareAgent, seedShareDiagrams, setSharing, stranger } from './support/shares.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.describe.configure({ timeout: 90_000 })

test.beforeEach(async ({ request }) => {
  await setSharing(request, true)
})

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/shares/revoke-all', { data: {} })).ok()).toBe(true)
  await setSharing(request, false)
  await resetPreviews(request)
})

/** Shares a file from its viewer, so the browser draws its diagrams, and returns the link. */
async function shareOpenFile(page: Page, file: string): Promise<string> {
  await openViewerFile(page, file)
  await filesPanel(page).getByTestId('viewer-header').getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog', { name: `Share ${file}` })
  await dialog.getByRole('button', { name: 'Create link' }).click()
  const link = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/share\/[A-Za-z0-9_-]{43}$/, { timeout: 60_000 })
  return link.inputValue()
}

async function openFiles(page: Page, id: string): Promise<void> {
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
}

const widthOf = async (image: Locator) => image.evaluate((img: HTMLImageElement) => img.getBoundingClientRect().width)

/** The width the diagram reads at, which 100% shows it at. */
const naturalOf = async (figure: Locator) =>
  Number.parseFloat(await figure.evaluate((el) => getComputedStyle(el).getPropertyValue('--w')))

test('a shared Markdown file shows its mermaid fence as an image that zooms with no script', async ({
  page,
  browser,
}) => {
  const { id, dir } = await seedShareAgent()
  seedShareDiagrams(dir)
  await openFiles(page, id)
  const url = await shareOpenFile(page, 'diagrams.md')

  const viewer = await stranger(browser)
  try {
    await openShare(viewer.page, url)
    const figure = viewer.page.locator('figure.diagram')
    const image = figure.getByRole('img', { name: 'mermaid diagram' })
    await expect.poll(async () => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await expect(viewer.page.locator('pre code')).toHaveText('ship()')
    await expect(viewer.page.getByText('Collect laptops')).toHaveCount(0)
    await expect(viewer.page.locator('svg, script')).toHaveCount(0)
    await expect(figure.getByRole('radio', { name: 'Fit' })).toBeChecked()
    const natural = await naturalOf(figure)
    expect(natural).toBeGreaterThan(50)
    const frame = figure.locator('.frame')
    const room = await frame.evaluate((el) => el.clientWidth)
    expect(await widthOf(image)).toBeCloseTo(Math.min(natural, room), 0)

    await figure.getByText('200%', { exact: true }).click()
    await expect(figure.getByRole('radio', { name: '200%' })).toBeChecked()
    await expect.poll(async () => widthOf(image)).toBeCloseTo(natural * 2, 0)
    expect(await frame.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(natural * 2 > room)
    await figure.getByText('100%', { exact: true }).click()
    await expect.poll(async () => widthOf(image)).toBeCloseTo(natural, 0)
    await figure.getByText('Fit', { exact: true }).click()
    await expect.poll(async () => widthOf(image)).toBeCloseTo(Math.min(natural, room), 0)

    const full = figure.getByRole('link', { name: 'Full size' })
    await expect(full).toHaveAttribute('href', /\/p\/1$/)
    await viewer.page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(async () => image.evaluate((img: HTMLImageElement) => img.currentSrc)).toMatch(/\/p\/2$/)
    await expect(full).toHaveAttribute('href', /\/p\/2$/)
    await viewer.page.screenshot({ path: test.info().outputPath('diagram-dark.png') })
    expect(viewer.errors).toEqual([])
  } finally {
    await viewer.close()
  }
})

test('a shared .mmd file shows its diagram and source, and with Mermaid off a fence stays code', async ({
  page,
  browser,
  request,
}) => {
  const { id, dir } = await seedShareAgent()
  seedShareDiagrams(dir)
  await openFiles(page, id)
  const url = await shareOpenFile(page, 'flow.mmd')
  await expect(page.getByTestId('share-preview')).toContainText('Mermaid diagram')
  await page.keyboard.press('Escape')

  await setPreviewFormat(request, 'mermaid', false)
  await page.reload()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await openViewerFile(page, 'flow.mmd')
  await expect(filesPanel(page).getByRole('note')).toContainText('Mermaid is off.')
  const plain = await shareOpenFile(page, 'diagrams.md')

  const viewer = await stranger(browser)
  try {
    await openShare(viewer.page, url)
    const image = viewer.page.getByRole('img', { name: 'Mermaid diagram' })
    await expect.poll(async () => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await viewer.page.getByText('View source').click()
    await expect(viewer.page.locator('details pre')).toContainText('Start[Collect laptops]')
    await viewer.page.screenshot({ path: test.info().outputPath('mmd-light.png'), fullPage: true })

    await openShare(viewer.page, plain)
    await expect(viewer.page.locator('figure')).toHaveCount(0)
    await expect(viewer.page.locator('pre code').first()).toContainText('Start[Collect laptops]')
    expect(viewer.errors).toEqual([])
  } finally {
    await viewer.close()
  }
})
