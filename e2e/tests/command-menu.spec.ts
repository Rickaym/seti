import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CommandCatalog, Envelope } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const PROBE_DELAY_MS = 8000
const UPDATING = 'Updating the list for this directory...'

test.use({ serverEnv: { SETI_PROBE_DELAY_MS: String(PROBE_DELAY_MS) } })

/** An idle agent in a directory Seti has never probed, written straight into the database. */
async function seedAgentInNewDirectory(): Promise<string> {
  const cwd = path.join(paths.root, `fresh-${randomUUID().slice(0, 8)}`)
  fs.mkdirSync(cwd)
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
     VALUES (?, 'Fresh directory', NULL, ?, 0, 'idle', ?, ?)`,
    id,
    cwd,
    ts,
    ts,
  )
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded prompt in a fresh directory.' }), ts)
  await db.close()
  return id
}

test('a new agent lists commands at once while its own slow probe runs', async ({ page, request }) => {
  test.setTimeout(180_000)
  const home = await request.get('/api/capabilities', { timeout: 90_000 })
  expect(home.ok()).toBe(true)

  const taskId = await seedAgentInNewDirectory()
  const started = Date.now()
  const first = await request.get(`/api/tasks/${taskId}/commands`)
  expect(Date.now() - started).toBeLessThan(PROBE_DELAY_MS / 4)
  const catalog = ((await first.json()) as Envelope<CommandCatalog>).data
  expect(catalog).toMatchObject({ fresh: false, approximate: true })
  expect(catalog.commands.map((command) => command.name)).toContain('compact')

  await page.goto(`/#agents/${taskId}`)
  await expect(page.getByText('Seeded prompt in a fresh directory.')).toBeVisible()
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('/comp')
  const list = page.getByRole('listbox', { name: 'Command suggestions' })
  await expect(list.getByRole('option', { name: /\/compact/ })).toBeVisible({ timeout: PROBE_DELAY_MS / 4 })
  await expect(list.getByText(UPDATING)).toBeVisible()

  await expect(list.getByText(UPDATING)).toBeHidden({ timeout: 90_000 })
  await expect(list.getByRole('option', { name: /\/compact/ })).toBeVisible()
  const exact = ((await (await request.get(`/api/tasks/${taskId}/commands`)).json()) as Envelope<CommandCatalog>).data
  expect(exact).toMatchObject({ fresh: true, approximate: false })
})
