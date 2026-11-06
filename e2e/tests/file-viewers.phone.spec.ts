import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile, seedViewerAgent } from './support/viewer-files.js'

async function openFiles(page: Page) {
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
}

test('diagrams, tables, workbooks and media fit a phone', async ({ page }) => {
  const { id } = await seedViewerAgent(500)
  await page.goto(`/#agents/${id}`)
  await openFiles(page)
  const panel = filesPanel(page)

  await openViewerFile(page, 'flow.mmd')
  const diagram = panel.getByRole('img', { name: 'Diagram of flow.mmd' })
  await expect(diagram.locator('svg')).toBeVisible()
  const fits = await diagram.evaluate((element) => {
    const frame = element.parentElement?.getBoundingClientRect()
    return frame !== undefined && element.getBoundingClientRect().width <= frame.width
  })
  expect(fits).toBe(true)
  await expectFitsPhone(page, 'mermaid file')

  await openViewerFile(page, 'rollout.md')
  await expect(
    panel.getByRole('figure', { name: 'Mermaid diagram' }).getByRole('img', { name: 'Diagram', exact: true }),
  ).toBeVisible()
  await expectFitsPhone(page, 'markdown with a diagram')

  await openViewerFile(page, 'people.csv')
  const grid = panel.getByRole('grid')
  await expect(grid.getByRole('columnheader', { name: 'city' })).toBeVisible()
  await expectFitsPhone(page, 'csv table')
  await grid.evaluate((element) => {
    element.scrollTo({ left: element.scrollWidth })
  })
  await expectFitsPhone(page, 'csv table scrolled sideways')

  await openViewerFile(page, 'budget.xlsx')
  await expect(panel.getByRole('tab', { name: 'Costs' })).toBeVisible()
  await expectFitsPhone(page, 'workbook')

  await openViewerFile(page, 'tone.wav')
  await expect(panel.getByLabel('Audio tone.wav')).toBeVisible()
  await expectFitsPhone(page, 'audio')
  await openViewerFile(page, 'clip.mp4')
  const video = panel.getByLabel('Video clip.mp4')
  await expect.poll(async () => video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(64)
  await expectFitsPhone(page, 'video')
  await openViewerFile(page, 'dot.webp')
  await expect(panel.getByRole('img', { name: 'dot.webp' })).toBeVisible()
  await expectFitsPhone(page, 'image')
})
