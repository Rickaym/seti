import { randomUUID } from 'node:crypto'
import type { WorkspaceEntry } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'

async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  await db.close()
  return id
}

test('phones show one agent and no grid or splitters, even with a grid stored on a desktop', async ({
  page,
  request,
}) => {
  const title = `Phone grid ${randomUUID().slice(0, 8)}`
  const id = await seedTask(title)
  const [main] = await apiData<WorkspaceEntry[]>(request, '/workspaces')
  const desktop = { panels: [{ i: 'p1', agent: id, x: 0, y: 0, w: 12, h: 24 }], locked: false }
  expect((await request.put(`/api/mods/grid/layouts/${main?.id ?? ''}`, { data: { layout: desktop } })).ok()).toBe(true)
  await page.addInitScript((taskId) => {
    const layout = { rows: 1, cols: 2, colSizes: [0.5, 0.5], rowSizes: [1], cells: [taskId, null] }
    localStorage.setItem('seti.agents.grid', JSON.stringify({ enabled: true, layout, focused: 0, recent: [] }))
  }, id)
  const gridRequests: string[] = []
  page.on('request', (sent) => {
    if (new URL(sent.url()).pathname.includes('/grid')) {
      gridRequests.push(sent.url())
    }
  })
  await page.goto('/#agents')
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Grid', exact: true })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Grid layout' })).toHaveCount(0)
  await expect(page.getByRole('separator', { name: /^Resize/ })).toHaveCount(0)

  await page.locator(`[data-task-id="${id}"] button`).first().click()
  await expect(page.getByTestId('agent-grid')).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('heading', { name: title })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open in grid' })).toHaveCount(0)
  await expect(page.locator('[draggable="true"]')).toHaveCount(0)
  expect(gridRequests, 'grid requests from a phone').toEqual([])
})
