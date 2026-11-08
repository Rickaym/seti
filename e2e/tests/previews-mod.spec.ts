import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { resetPreviews, setPreviewFormat } from './support/mods.js'
import { makePdf } from './support/share-files.js'
import { filesPanel, openViewerFile, seedViewerAgent } from './support/viewer-files.js'

test.afterEach(async ({ request }) => {
  await resetPreviews(request)
})

async function seedWithPdf(): Promise<string> {
  const { id, dir } = await seedViewerAgent(10)
  fs.writeFileSync(path.join(dir, 'docs', 'report.pdf'), makePdf(3, 'Quarterly report'))
  return id
}

async function openAgentFiles(page: Page, id: string): Promise<void> {
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
}

/** Each format drawn by Previews: the PDF's pages, the csv's grid, the workbook's tabs, diagrams. */
async function expectAllPreviews(page: Page): Promise<void> {
  const panel = filesPanel(page)
  await openViewerFile(page, 'report.pdf')
  await expect(panel.getByText('Page 1 of 3')).toBeVisible()
  await openViewerFile(page, 'people.csv')
  await expect(panel.getByRole('grid').getByRole('columnheader', { name: 'city' })).toBeVisible()
  await openViewerFile(page, 'budget.xlsx')
  await expect(panel.getByRole('tab', { name: 'Costs' })).toBeVisible()
  await openViewerFile(page, 'flow.mmd')
  await expect(panel.getByRole('img', { name: 'Diagram of flow.mmd' }).locator('svg')).toBeVisible()
  await openViewerFile(page, 'rollout.md')
  await expect(
    panel.getByRole('figure', { name: 'Mermaid diagram' }).getByRole('img', { name: 'Diagram' }),
  ).toBeVisible()
  await expect(panel.getByRole('note')).toHaveCount(0)
}

test('Previews draws a PDF page by page', async ({ page }) => {
  const id = await seedWithPdf()
  await openAgentFiles(page, id)
  await openViewerFile(page, 'report.pdf')
  const panel = filesPanel(page)
  await expect(panel.getByText('Page 1 of 3')).toBeVisible()
  await expect(panel.locator('canvas')).toHaveCount(1)
  await panel.getByRole('button', { name: 'Next page' }).click()
  await expect(panel.getByText('Page 2 of 3')).toBeVisible()
})

test('a format switched off falls back alone, and its line opens the Previews settings at that switch', async ({
  page,
  request,
}) => {
  const id = await seedWithPdf()
  await setPreviewFormat(request, 'pdf', false)
  await openAgentFiles(page, id)
  const panel = filesPanel(page)

  await openViewerFile(page, 'people.csv')
  await expect(panel.getByRole('grid').getByRole('columnheader', { name: 'city' })).toBeVisible()
  await openViewerFile(page, 'flow.mmd')
  await expect(panel.getByRole('img', { name: 'Diagram of flow.mmd' }).locator('svg')).toBeVisible()
  await openViewerFile(page, 'report.pdf')
  await expect(panel.getByText(/^This file has no preview\./)).toBeVisible()
  await expect(panel.locator('canvas')).toHaveCount(0)
  const note = panel.getByRole('note').filter({ hasText: 'Previews shows these files. PDF is off.' })
  await expect(note.getByRole('button', { name: 'Turn on' })).toHaveCount(0)

  await note.getByRole('button', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/#settings\/previews\.settings\/pdf$/)
  const main = page.getByRole('main')
  const pdfSwitch = main.getByRole('button', { name: 'PDF', exact: true })
  await expect(pdfSwitch).toHaveAttribute('aria-pressed', 'false')
  await expect(pdfSwitch).toBeFocused()
  await pdfSwitch.click()
  await expect(pdfSwitch).toHaveAttribute('aria-pressed', 'true')
  const sheetsSwitch = main.getByRole('button', { name: 'Spreadsheets and CSV', exact: true })
  await sheetsSwitch.click()
  await expect(sheetsSwitch).toHaveAttribute('aria-pressed', 'false')
  await main.getByRole('button', { name: 'Mermaid', exact: true }).click()
  await expect(main.getByRole('button', { name: 'Mermaid', exact: true })).toHaveAttribute('aria-pressed', 'false')

  await openAgentFiles(page, id)
  await openViewerFile(page, 'report.pdf')
  await expect(panel.getByText('Page 1 of 3')).toBeVisible()
  await openViewerFile(page, 'people.csv')
  await expect(panel.getByText('id,name,city')).toBeVisible()
  await expect(panel.getByRole('note')).toContainText('Spreadsheets and CSV is off.')
  await openViewerFile(page, 'budget.xlsx')
  await expect(panel.getByText(/This file has no preview\./)).toBeVisible()
  await openViewerFile(page, 'flow.mmd')
  await expect(panel.getByText('Start[Collect laptops]')).toBeVisible()
  await expect(panel.getByRole('note')).toContainText('Mermaid is off.')
  await openViewerFile(page, 'rollout.md')
  await expect(panel.locator('pre').filter({ hasText: 'sequenceDiagram' })).toBeVisible()

  await setPreviewFormat(request, 'sheets', true)
  await setPreviewFormat(request, 'mermaid', true)
  await page.reload()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expectAllPreviews(page)
})

test('a mermaid fence in Markdown zooms in and out, scrolls in its frame and fits back', async ({ page }) => {
  const id = await seedWithPdf()
  await openAgentFiles(page, id)
  await openViewerFile(page, 'rollout.md')
  const figure = filesPanel(page).getByRole('figure', { name: 'Mermaid diagram' })
  const diagram = figure.getByRole('img', { name: 'Diagram' })
  await expect(diagram.locator('svg')).toBeVisible()
  const fitted = (await diagram.boundingBox())?.width ?? 0
  const level = figure.getByText(/^\d+%$/)
  const fit = await level.innerText()
  await figure.getByRole('button', { name: 'Zoom in' }).click()
  await expect(level).not.toHaveText(fit)
  await expect.poll(async () => (await diagram.boundingBox())?.width ?? 0).toBeCloseTo(fitted * 1.25, 0)
  const frame = figure.getByTestId('diagram-frame')
  await figure.getByRole('button', { name: 'Zoom in' }).click()
  await figure.getByRole('button', { name: 'Zoom in' }).click()
  expect(await frame.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  for (let n = 0; n < 4; n += 1) {
    await figure.getByRole('button', { name: 'Zoom out' }).click()
  }
  await expect.poll(async () => (await diagram.boundingBox())?.width ?? 0).toBeCloseTo(fitted / 1.25, 0)
  await figure.getByRole('button', { name: 'Fit to width' }).click()
  await expect(level).toHaveText(fit)
  await figure.getByRole('button', { name: 'Source' }).click()
  await expect(figure.locator('pre')).toContainText('sequenceDiagram')
  await expect(figure.getByRole('button', { name: 'Zoom in' })).toHaveCount(0)
})
