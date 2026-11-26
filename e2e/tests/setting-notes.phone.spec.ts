import { randomUUID } from 'node:crypto'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test("a change to an agent's sandbox leaves a line that fits a phone", async ({ page, request }) => {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, unique('Phone sandbox note'), paths.checkout, new Date().toISOString())
  await db.close()
  expect((await request.patch(`/api/tasks/${id}`, { data: { sandbox: false } })).ok()).toBe(true)

  await page.goto(`/#agents/${id}`)
  await expect(page.getByText("Sandbox off from the next turn: the agent uses this machine's own access")).toBeVisible()
  await expectFitsPhone(page, 'the sandbox note')
  await test.info().attach('phone-note', { body: await page.screenshot(), contentType: 'image/png' })
})
