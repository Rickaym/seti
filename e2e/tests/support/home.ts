import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { unique } from './fixtures.js'

export interface Shipped {
  id: string
  title: string
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

/** An idle agent with one turn, one GitHub MCP call and one PR that merged an hour ago. */
export async function seedShipped(prefix: string): Promise<Shipped> {
  const db = openSeedDb()
  const id = randomUUID()
  const title = unique(prefix)
  const pr = `https://github.com/acme/web/pull/${String(Date.now() % 100_000)}`
  await db.idleTask(id, title, paths.checkout, hoursAgo(3))
  await db.run(`UPDATE task SET color = '#3baca6' WHERE id = ?`, id)
  const call = { type: 'tool_use', id: `toolu_${id.slice(0, 8)}`, name: 'mcp__github__create_pull_request', input: {} }
  await db.message(id, 'sdk', JSON.stringify({ type: 'assistant', message: { content: [call] } }), hoursAgo(2.5))
  const result = { type: 'result', subtype: 'success', duration_ms: 90_000, seti_turn_cost_usd: 0.42 }
  await db.message(id, 'sdk', JSON.stringify(result), hoursAgo(2))
  const snapshot = { state: 'merged', conflicting: false, ci: null, review_ids: [], comment_ids: [] }
  await db.run(
    `INSERT INTO pr_watch (pr_url, snapshot, open, checked_at) VALUES (?, ?, 0, ?)`,
    pr,
    JSON.stringify(snapshot),
    hoursAgo(1),
  )
  await db.run(`INSERT INTO task_pr_dismissed (task_id, pr_url, at) VALUES (?, ?, ?)`, id, pr, hoursAgo(1))
  await db.close()
  return { id, title }
}

const STEP = 22

/**
 * Points at the graph until the node card names `title`, since the canvas has no elements to
 * target; `act` hovers or taps a point. Returns the point that found it.
 */
export async function findNode(
  page: Page,
  title: string,
  act: (x: number, y: number) => Promise<void>,
  reach = 1,
): Promise<{ x: number; y: number } | null> {
  const box = await page.getByTestId('home-graph').boundingBox()
  if (box === null) {
    return null
  }
  const card = page.getByTestId('home-card').getByRole('heading', { name: title })
  const other = page.getByTestId('home-card').getByRole('button', { name: 'Close' })
  for (let y = box.y + STEP / 2; y < box.y + box.height * reach; y += STEP) {
    for (let x = box.x + STEP / 2; x < box.x + box.width; x += STEP) {
      await act(x, y)
      if ((await card.count()) > 0) {
        return { x, y }
      }
      if ((await other.count()) > 0) {
        await other.click()
      }
    }
  }
  return null
}
