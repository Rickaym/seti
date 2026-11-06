import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openSeedDb } from './support/db.js'
import { expect, test } from './support/fixtures.js'
import { CSV_ROWS, FLOW, NOTE, filesPanel, openViewerFile, seedViewerAgent } from './support/viewer-files.js'

test('a mermaid file draws its diagram, shows its source, redraws on save and explains errors', async ({ page }) => {
  const { id, dir } = await seedViewerAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)

  await openViewerFile(page, 'flow.mmd')
  const diagram = panel.getByRole('img', { name: 'Diagram of flow.mmd' })
  await expect(diagram.locator('svg')).toBeVisible()
  await expect(diagram).toContainText(/Collect\s*laptops/)

  await panel.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(panel.getByText('Start[Collect laptops]')).toBeVisible()
  await expect(diagram).toHaveCount(0)
  await panel.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(diagram.locator('svg')).toBeVisible()

  await panel.getByRole('button', { name: 'Zoom in' }).click()
  await expect(panel.getByText(/^\d+%$/)).not.toHaveText('100%')

  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = panel.getByRole('textbox', { name: 'Edit docs/flow.mmd' })
  await editor.fill(`${FLOW}  Ship --> Done[Badge printed]\n`)
  await editor.press('Control+s')
  await expect.poll(() => fs.readFileSync(path.join(dir, 'docs', 'flow.mmd'), 'utf8')).toContain('Badge printed')
  await expect(panel.getByRole('region', { name: 'Saved diagram' })).toContainText(/Badge\s*printed/)

  await openViewerFile(page, 'broken.mermaid')
  const error = panel.getByRole('alert')
  await expect(error).toContainText('This diagram has an error')
  await expect(error).toContainText(/line \d/)
  await expect(panel.getByRole('img', { name: /Diagram of/ })).toHaveCount(0)
})

test('mermaid fences render in a Markdown file and in the transcript', async ({ page }) => {
  const { id } = await seedViewerAgent(10)
  const db = openSeedDb()
  const at = new Date().toISOString()
  const reply = {
    type: 'assistant',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: NOTE }],
    },
    parent_tool_use_id: null,
    session_id: 'viewers-session',
    uuid: randomUUID(),
  }
  await db.message(id, 'sdk', JSON.stringify(reply), at)
  await db.close()
  await page.goto(`/#agents/${id}`)

  const transcript = page.getByRole('region', { name: 'Transcript' })
  await expect(
    transcript.getByRole('figure', { name: 'Mermaid diagram' }).getByRole('img', { name: 'Diagram', exact: true }),
  ).toBeVisible()
  await expect(transcript.getByRole('figure', { name: 'Mermaid diagram' })).toContainText('Opens the pull request')

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await openViewerFile(page, 'rollout.md')
  const figure = filesPanel(page).getByRole('figure', { name: 'Mermaid diagram' })
  await expect(figure.getByRole('img', { name: 'Diagram', exact: true })).toBeVisible()
  await figure.getByRole('button', { name: 'Source' }).click()
  await expect(figure.getByText('sequenceDiagram')).toBeVisible()
})

test('images a Markdown file links beside it show in the preview', async ({ page }) => {
  const { id } = await seedViewerAgent(10)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await openViewerFile(page, 'report.md')
  const image = filesPanel(page).getByRole('img', { name: 'Latency chart' })
  await expect(image).toHaveAttribute('src', /\/files\/raw\?.*docs%2Fdot\.png/)
  await expect.poll(async () => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
})

test('a csv of 50,000 rows scrolls, filters and copies a cell', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const { id } = await seedViewerAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await openViewerFile(page, 'people.csv')

  const grid = panel.getByRole('grid')
  await expect(grid.getByRole('columnheader', { name: 'city' })).toBeVisible()
  await expect(panel.getByText(`${CSV_ROWS.toLocaleString('en-US')} rows`)).toBeVisible()
  expect(await grid.getByRole('row').count()).toBeLessThan(100)

  await grid.evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight })
  })
  await expect(grid.getByRole('gridcell', { name: `Person ${String(CSV_ROWS)}`, exact: true })).toBeVisible()
  expect(await grid.getByRole('row').count()).toBeLessThan(100)

  await panel.getByRole('textbox', { name: 'Filter rows' }).fill('person 4242')
  await expect(panel.getByText(`11 of ${CSV_ROWS.toLocaleString('en-US')} rows`, { exact: true })).toBeVisible()
  const cell = grid.getByRole('gridcell', { name: 'Person 4242', exact: true })
  await cell.click()
  await panel.getByRole('button', { name: 'Cell', exact: true }).click()
  await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toBe('Person 4242')
  await panel.getByRole('button', { name: 'Row', exact: true }).click()
  await expect
    .poll(async () => page.evaluate(async () => navigator.clipboard.readText()))
    .toBe('4242\tPerson 4242\tCity 2')

  await panel.getByRole('button', { name: 'Header', exact: true }).click()
  await expect(grid.getByRole('columnheader', { name: 'C', exact: true })).toBeVisible()
  await panel.getByRole('textbox', { name: 'Filter rows' }).fill('')
  await panel.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(panel.getByText('id,name,city')).toBeVisible()
})

test('a workbook shows each sheet in its own tab with formulas on hover', async ({ page }) => {
  const { id } = await seedViewerAgent(10)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await openViewerFile(page, 'budget.xlsx')

  const tabs = panel.getByRole('tablist', { name: 'Sheets' })
  await expect(tabs.getByRole('tab', { name: 'Revenue' })).toHaveAttribute('aria-selected', 'true')
  const grid = panel.getByRole('grid')
  await expect(grid.getByRole('gridcell', { name: 'Quarterly revenue' })).toBeVisible()
  await expect(grid.getByRole('gridcell', { name: '3000' })).toHaveAttribute('title', '3000\n=SUM(B3:B4)')
  await expect(grid.getByRole('columnheader', { name: 'B', exact: true })).toBeVisible()

  await tabs.getByRole('tab', { name: 'Costs' }).click()
  await expect(tabs.getByRole('tab', { name: 'Costs' })).toHaveAttribute('aria-selected', 'true')
  await expect(grid.getByRole('gridcell', { name: 'Monitors' })).toBeVisible()
  await expect(grid.getByRole('gridcell', { name: 'Quarterly revenue' })).toHaveCount(0)
})

test('audio, video and images preview in place, and unplayable media offers a download', async ({ page }) => {
  const { id } = await seedViewerAgent(10)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)

  await openViewerFile(page, 'tone.wav')
  const audio = panel.getByLabel('Audio tone.wav')
  await expect(audio).toBeVisible()
  await expect(panel.getByText(/audio\/wav/)).toBeVisible()
  await expect.poll(async () => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeGreaterThan(0.4)
  expect(await audio.evaluate((el: HTMLAudioElement) => [el.paused, el.preload])).toEqual([true, 'metadata'])

  await openViewerFile(page, 'clip.mp4')
  const video = panel.getByLabel('Video clip.mp4')
  await expect.poll(async () => video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(64)
  expect(await video.evaluate((el: HTMLVideoElement) => [el.paused, el.playsInline])).toEqual([true, true])

  for (const name of ['dot.png', 'dot.webp']) {
    await openViewerFile(page, name)
    const image = panel.getByRole('img', { name })
    await expect.poll(async () => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(32)
  }

  await openViewerFile(page, 'broken.mp4')
  await expect(panel.getByText('This browser cannot play this file.')).toBeVisible()
  await expect(panel.getByRole('link', { name: 'Download', exact: true })).toBeVisible()

  const raw = `/api/tasks/${id}/files/raw?root=cwd&path=docs%2Ftone.wav`
  const part = await page.request.get(raw, { headers: { Range: 'bytes=0-99' } })
  expect(part.status()).toBe(206)
  expect(part.headers()['content-range']).toBe('bytes 0-99/4078')
  expect(part.headers()['content-type']).toBe('audio/wav')
  expect(await part.body()).toHaveLength(100)
  expect((await page.request.get(raw, { headers: { Range: 'bytes=9000-' } })).status()).toBe(416)
})
