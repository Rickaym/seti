import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { AuditPage } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'

/** A PDF of `pages` pages, each a 200 pt square with a blue box and no fonts to load. */
function tinyPdf(pages: number): Buffer {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>']
  const kids = Array.from({ length: pages }, (_, i) => `${String(3 + i * 2)} 0 R`).join(' ')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages)} >>`)
  for (let i = 0; i < pages; i++) {
    const stream = `0.1 0.3 0.9 rg 20 20 160 ${String(40 + i * 60)} re f`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${String(4 + i * 2)} 0 R /Resources << >> >>`,
      `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    )
  }
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body))
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  const rows = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${rows}`
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

const assistant = (content: unknown[]) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content },
  parent_tool_use_id: null,
  session_id: 'files-session',
  uuid: randomUUID(),
})

const NOTE = '# Onboarding plan\n\n- Welcome pack\n'
const MENTION = 'The updated files are out/sample-welcome.pdf (Developer) and out/missing.pdf (FDE).'

/** An idle agent whose working directory holds a PDF and a note, and whose transcript names them. */
async function seedAgent(): Promise<{ id: string; dir: string }> {
  const id = randomUUID()
  const dir = path.join(paths.root, `files-${id.slice(0, 8)}`)
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'out', 'sample-welcome.pdf'), tinyPdf(3))
  fs.writeFileSync(path.join(dir, 'notes', 'plan.md'), NOTE)
  const db = openSeedDb()
  const started = new Date(Date.now() - 60_000).toISOString()
  await db.idleTask(id, 'Welcome pack', dir, started)
  const write = {
    type: 'tool_use',
    id: 'toolu_write_plan',
    name: 'Write',
    input: { file_path: path.join(dir, 'notes', 'plan.md'), content: NOTE },
  }
  await db.message(id, 'prompt', JSON.stringify({ text: 'Make the welcome pack.' }), started)
  await db.message(id, 'sdk', JSON.stringify(assistant([write])), started)
  await db.message(id, 'sdk', JSON.stringify(assistant([{ type: 'text', text: MENTION }])), started)
  await db.close()
  return { id, dir }
}

const files = (page: Page) => page.getByRole('region', { name: 'Files', exact: true })

/** The colour at the middle of the PDF canvas, which the blue box covers on every page. */
const centrePixel = async (page: Page) =>
  files(page)
    .locator('canvas')
    .evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')
      const pixel = context?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height * 0.8), 1, 1).data
      return pixel === undefined ? null : [pixel[0], pixel[1], pixel[2]]
    })

test('the Files panel shows a recent PDF, edits a note and follows paths from the transcript', async ({ page }) => {
  const { id, dir } = await seedAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()

  const panel = files(page)
  await expect(panel.getByRole('button', { name: /sample-welcome\.pdf/ })).toBeVisible()
  await panel.getByRole('button', { name: /sample-welcome\.pdf/ }).click()
  await expect(panel.getByText('Page 1 of 3')).toBeVisible()
  await expect.poll(async () => centrePixel(page)).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)])
  await expect.poll(async () => (await centrePixel(page))?.[2] ?? 0).toBeGreaterThan(150)
  await panel.getByRole('button', { name: 'Next page' }).click()
  await expect(panel.getByText('Page 2 of 3')).toBeVisible()

  await panel.getByRole('button', { name: 'Back to the folder' }).click()
  await panel.getByRole('button', { name: /plan\.md/ }).click()
  await expect(panel.getByRole('heading', { name: 'Onboarding plan' })).toBeVisible()

  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = panel.getByRole('textbox', { name: 'Edit notes/plan.md' })
  await editor.fill(`${NOTE}- Laptop setup\n`)
  await editor.press('Control+s')
  await expect.poll(() => fs.readFileSync(path.join(dir, 'notes', 'plan.md'), 'utf8')).toBe(`${NOTE}- Laptop setup\n`)
  const audited = async () =>
    (await apiData<AuditPage>(page.request, '/audit?kind=task.file_saved&limit=20')).events.find(
      (event) => event.subject_id === id,
    )
  await expect.poll(async () => (await audited())?.detail.path).toBe('notes/plan.md')

  await editor.fill(`${NOTE}- My unsaved line\n`)
  fs.writeFileSync(path.join(dir, 'notes', 'plan.md'), `${NOTE}- Agent line\n`)
  const banner = panel.getByRole('alert')
  await expect(banner).toContainText('Changed on disk since you opened it')
  await banner.getByRole('button', { name: 'Reload' }).click()
  await expect(editor).toContainText('- Agent line')
  await expect(banner).toHaveCount(0)

  await panel.getByRole('button', { name: 'Stop editing' }).click()
  fs.writeFileSync(path.join(dir, 'notes', 'plan.md'), `${NOTE}- Live from the agent\n`)
  await expect(panel.getByText('Live from the agent')).toBeVisible()

  await panel.getByRole('button', { name: 'Close Files' }).click()
  await expect(panel).toHaveCount(0)
  const transcript = page.getByRole('region', { name: 'Transcript' })
  await expect(transcript.getByText('out/missing.pdf')).toBeVisible()
  await expect(transcript.locator('[data-file-link="out/missing.pdf"]')).toHaveCount(0)
  await transcript.locator('[data-file-link="out/sample-welcome.pdf"]').click()
  await expect(files(page).getByText('Page 1 of 3')).toBeVisible()

  await transcript.getByRole('button', { name: 'Open notes/plan.md in Files' }).click()
  await expect(files(page).getByText('Live from the agent')).toBeVisible()
})
