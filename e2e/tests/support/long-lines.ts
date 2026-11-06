import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

/** Lines of an ordinary page, numbered so no two read the same. */
const pageLines = (count: number, tag: string) =>
  Array.from({ length: count }, (_, n) => `    <p class="${tag}">Paragraph ${String(n)} of the report.</p>`)

/** One minified script line of about `chars` characters, dense with tokens like bundled data. */
function scriptLine(chars: number): string {
  const items: string[] = []
  let length = 0
  while (length < chars) {
    const n = items.length
    const item = `{"id":${String(n)},"name":"Item ${String(n)}","score":0.${String(n % 97)},"on":${String(n % 2 === 0)}}`
    items.push(item)
    length += item.length + 1
  }
  return `<script>window.DATA=[${items.join(',')}];</script>`
}

/** A page whose data sits on one line of about 474,000 characters, 179 lines in all. */
function longLinePage(): string {
  const head = ['<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<title>Report</title>']
  const page = [...head, '</head>', '<body>', scriptLine(474_000), ...pageLines(169, 'body'), '</body>', '</html>']
  return `${page.join('\n')}\n`
}

/** About 8 MB over 3,887 lines with inline scripts, the longest about 3.18 million characters. */
function hugePage(): string {
  const filler = pageLines(3_883, 'row').map((line) => `${line}${' '.repeat(1_300)}`)
  return `${['<!doctype html>', '<html>', scriptLine(3_180_000), ...filler, '</html>'].join('\n')}\n`
}

/** An idle agent whose docs hold the long-line page and the 8 MB page. */
export async function seedLongLineAgent(): Promise<{ id: string; dir: string }> {
  const id = randomUUID()
  const dir = path.join(paths.root, `long-${id.slice(0, 8)}`)
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'long-line.html'), longLinePage())
  fs.writeFileSync(path.join(dir, 'docs', 'huge-page.html'), hugePage())
  const db = openSeedDb()
  await db.idleTask(id, 'Long lines', dir, new Date(Date.now() - 60_000).toISOString())
  await db.close()
  return { id, dir }
}

/** Records every long task on the page from its first script on. */
export async function watchLongTasks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: number[] = []
    Object.assign(window, { longTasks: seen })
    new PerformanceObserver((list) => {
      seen.push(...list.getEntries().map((entry) => entry.duration))
    }).observe({ type: 'longtask', buffered: true })
  })
}

/** The longest task seen so far, in milliseconds. */
export async function longestTask(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, ...((window as unknown as { longTasks?: number[] }).longTasks ?? [])))
}
