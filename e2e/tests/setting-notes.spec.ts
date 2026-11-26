import { randomUUID } from 'node:crypto'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test, unique } from './support/fixtures.js'

test("a change to an agent's sandbox leaves a line in its transcript", async ({ page, request }) => {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, unique('Sandbox note'), paths.checkout, new Date().toISOString())
  await db.close()
  expect((await request.patch(`/api/tasks/${id}`, { data: { sandbox: false } })).ok()).toBe(true)

  await page.goto(`/#agents/${id}`)
  await expect(page.getByText("Sandbox off from the next turn: the agent uses this machine's own access")).toBeVisible()
})
