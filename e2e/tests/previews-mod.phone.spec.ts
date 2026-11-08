import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { resetPreviews, setPreviewFormat } from './support/mods.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { makePdf } from './support/share-files.js'
import { filesPanel, openViewerFile, seedViewerAgent } from './support/viewer-files.js'

test.afterEach(async ({ request }) => {
  await resetPreviews(request)
})

async function openFiles(page: Page): Promise<void> {
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
}

async function seedWithPdf(): Promise<string> {
  const { id, dir } = await seedViewerAgent(10)
  fs.writeFileSync(path.join(dir, 'docs', 'report.pdf'), makePdf(2, 'Quarterly report'))
  return id
}

test('the phone draws a PDF, a workbook and a diagram with Previews, which is always on', async ({ page }) => {
  const id = await seedWithPdf()
  await page.goto(`/#agents/${id}`)
  await openFiles(page)
  await openViewerFile(page, 'report.pdf')
  const panel = filesPanel(page)
  await expect(panel.getByText('Page 1 of 2')).toBeVisible()
  await expectFitsPhone(page, 'a PDF')
  await openViewerFile(page, 'budget.xlsx')
  await expect(panel.getByRole('tab', { name: 'Costs' })).toBeVisible()
  await openViewerFile(page, 'flow.mmd')
  await expect(panel.getByRole('img', { name: 'Diagram of flow.mmd' }).locator('svg')).toBeVisible()
  await expect(panel.getByRole('note')).toHaveCount(0)
})

test('on a phone a format switched off falls back alone, and its line opens the switch in settings', async ({
  page,
  request,
}) => {
  const id = await seedWithPdf()
  await setPreviewFormat(request, 'sheets', false)
  await page.goto(`/#agents/${id}`)
  await openFiles(page)
  const panel = filesPanel(page)
  await openViewerFile(page, 'report.pdf')
  await expect(panel.getByText('Page 1 of 2')).toBeVisible()
  await openViewerFile(page, 'budget.xlsx')
  await expect(panel.getByText(/This file has no preview\./)).toBeVisible()
  await openViewerFile(page, 'people.csv')
  await expect(panel.getByText('id,name,city')).toBeVisible()
  const note = panel.getByRole('note').filter({ hasText: 'Previews shows these files. Spreadsheets and CSV is off.' })
  await expect(note).toBeVisible()
  await expectFitsPhone(page, 'a csv with its Previews switch off')

  await note.getByRole('button', { name: 'Settings' }).tap()
  await expect(page).toHaveURL(/#settings\/previews\.settings\/sheets$/)
  const sheetsSwitch = page.getByRole('main').getByRole('button', { name: 'Spreadsheets and CSV', exact: true })
  await expect(sheetsSwitch).toBeInViewport()
  await expectFitsPhone(page, 'the Previews settings')
  await sheetsSwitch.tap()
  await expect(sheetsSwitch).toHaveAttribute('aria-pressed', 'true')

  await page.goto(`/#agents/${id}`)
  await openFiles(page)
  await openViewerFile(page, 'people.csv')
  await expect(panel.getByRole('grid').getByRole('columnheader', { name: 'city' })).toBeVisible()
  await expect(note).toHaveCount(0)
})

test('on a phone a mermaid fence in Markdown zooms inside its frame and fits back', async ({ page }) => {
  const { id } = await seedViewerAgent(10)
  await page.goto(`/#agents/${id}`)
  await openFiles(page)
  await openViewerFile(page, 'rollout.md')
  const figure = filesPanel(page).getByRole('figure', { name: 'Mermaid diagram' })
  const diagram = figure.getByRole('img', { name: 'Diagram' })
  await expect(diagram.locator('svg')).toBeVisible()
  const fitted = (await diagram.boundingBox())?.width ?? 0
  await figure.getByRole('button', { name: 'Zoom in' }).tap()
  await figure.getByRole('button', { name: 'Zoom in' }).tap()
  await expect.poll(async () => (await diagram.boundingBox())?.width ?? 0).toBeGreaterThan(fitted * 1.4)
  const frame = figure.getByTestId('diagram-frame')
  expect(await frame.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await expectFitsPhone(page, 'a zoomed diagram in Markdown')
  await figure.getByRole('button', { name: 'Fit to width' }).tap()
  await expect.poll(async () => (await diagram.boundingBox())?.width ?? 0).toBeCloseTo(fitted, 0)
})
