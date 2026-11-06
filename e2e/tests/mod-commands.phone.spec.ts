import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test, toasts } from './support/fixtures.js'
import { resetSampleMod } from './support/mods.js'
import { tapMoreAction } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.afterEach(async ({ request }) => {
  await resetSampleMod(request)
})

/** An idle agent written straight into the database, so no agent turn ever starts. */
async function seedTask(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
     VALUES (?, 'Mod commands on a phone', NULL, ?, 0, 'idle', ?, ?)`,
    id,
    paths.checkout,
    ts,
    ts,
  )
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded prompt for mod commands.' }), ts)
  await db.close()
  return id
}

const status = (page: Page) => page.getByRole('status', { name: 'Composer status' })

test("the phone's composer says a mod is off, turns it on with one tap, then runs its command", async ({ page }) => {
  const id = await seedTask()
  await page.goto(`/#agents/${id}`)
  await expect(page.getByText('Seeded prompt for mod commands.')).toBeVisible()
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('/sample from the phone')
  await expect(status(page)).toContainText('Sample is off')
  const turnOn = status(page).getByRole('button', { name: 'Turn on' })
  const box = await turnOn.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'the off notice in the composer')

  await turnOn.tap()
  await expect(toasts(page).filter({ hasText: 'Sample is on' })).toBeVisible()
  await page.getByRole('button', { name: 'Wave', exact: true }).tap()
  await expect(reply).toHaveValue('')
  await expect(toasts(page).filter({ hasText: `The sample waved at ${id} for the user: from the phone` })).toBeVisible()

  await tapMoreAction(page, 'Search Seti')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill('>sample count')
  await palette.getByRole('option', { name: /^Count/ }).tap()
  await expect(toasts(page).filter({ hasText: /The sample counted to \d+/ })).toBeVisible()
})
