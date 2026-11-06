import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const TARGET_PX = 44

test('a phone sees and reaches the directory actions without hovering', async ({ page, request }) => {
  const notes = path.join(paths.home, `notes-${randomUUID().slice(0, 8)}`)
  fs.mkdirSync(notes, { recursive: true })
  const id = randomUUID()
  const db = openSeedDb()
  await db.idleTask(id, 'Phone directories', paths.checkout, new Date().toISOString())
  await db.close()
  expect((await request.post(`/api/tasks/${id}/dirs`, { data: { path: notes } })).ok()).toBe(true)

  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).click()
  const row = page.getByRole('dialog').getByRole('group', { name: notes })
  for (const name of [`Work in ${notes}`, `Remove ${notes}`]) {
    const button = row.getByRole('button', { name })
    await expect(button).toHaveCSS('opacity', '1')
    const box = await button.boundingBox()
    expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(TARGET_PX)
  }
  const add = page.getByRole('dialog').getByRole('button', { name: 'Add repo or directory' })
  expect((await add.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(TARGET_PX)
})
