import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { utils, write } from 'xlsx'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

export const FLOW = 'flowchart TD\n  Start[Collect laptops] --> Check{Wiped?}\n  Check -->|yes| Ship[Ship to office]\n'
const BROKEN = 'flowchart TD\n  A --> B\n  B --> [unclosed\n'
export const NOTE = [
  '# Rollout',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  Agent->>Reviewer: Opens the pull request',
  '```',
  '',
].join('\n')
export const CSV_ROWS = 50_000

/** A comma-separated table with a header and `rows` rows, the city cycling through ten names. */
function csvText(rows: number): string {
  const lines = ['id,name,city']
  for (let i = 1; i <= rows; i++) {
    lines.push(`${String(i)},"Person ${String(i)}",City ${String(i % 10)}`)
  }
  return `${lines.join('\n')}\n`
}

/** Two sheets: revenue with a formula and a merged title, and a short list of costs. */
function workbook(): Buffer {
  const book = utils.book_new()
  const revenue = utils.aoa_to_sheet([['Quarterly revenue'], ['Quarter', 'Amount'], ['Q1', 1200], ['Q2', 1800]])
  revenue.A5 = { t: 's', v: 'Total' }
  revenue.B5 = { t: 'n', v: 3000, f: 'SUM(B3:B4)' }
  revenue['!ref'] = 'A1:B5'
  revenue['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]
  utils.book_append_sheet(book, revenue, 'Revenue')
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([
      ['Item', 'Cost'],
      ['Laptops', 950],
      ['Monitors', 320],
    ]),
    'Costs',
  )
  return write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/** Tiny media files: a wav tone, an H.264 mp4, and a png and webp with transparent edges. */
const MEDIA = ['tone.wav', 'clip.mp4', 'dot.png', 'dot.webp']

/** An idle agent whose working directory holds a diagram, a note, a table, a workbook and media. */
export async function seedViewerAgent(rows = CSV_ROWS): Promise<{ id: string; dir: string }> {
  const id = randomUUID()
  const dir = path.join(paths.root, `viewers-${id.slice(0, 8)}`)
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'flow.mmd'), FLOW)
  fs.writeFileSync(path.join(dir, 'docs', 'broken.mermaid'), BROKEN)
  fs.writeFileSync(path.join(dir, 'docs', 'rollout.md'), NOTE)
  fs.writeFileSync(path.join(dir, 'docs', 'report.md'), '# Drill\n\n![Latency chart](dot.png)\n')
  fs.writeFileSync(path.join(dir, 'docs', 'people.csv'), csvText(rows))
  fs.writeFileSync(path.join(dir, 'docs', 'budget.xlsx'), workbook())
  for (const name of MEDIA) {
    fs.copyFileSync(path.join(import.meta.dirname, 'media', name), path.join(dir, 'docs', name))
  }
  fs.writeFileSync(path.join(dir, 'docs', 'broken.mp4'), 'not a video\n')
  const db = openSeedDb()
  await db.idleTask(id, 'Office move', dir, new Date(Date.now() - 60_000).toISOString())
  await db.close()
  return { id, dir }
}

export const filesPanel = (page: Page) => page.getByRole('region', { name: 'Files', exact: true })

/** Opens the agent's Files panel and, from the docs folder, the file with this name. */
export async function openViewerFile(page: Page, name: string): Promise<void> {
  const panel = filesPanel(page)
  const back = panel.getByRole('button', { name: 'Back to the folder' })
  if (await back.isVisible()) {
    await back.click()
  }
  await panel.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).click()
  await panel.getByRole('region', { name: `File docs/${name}` }).waitFor()
}
