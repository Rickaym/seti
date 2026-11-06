import { randomUUID } from 'node:crypto'
import type { Task } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('the Seti control levels fit a phone and change with a tap', async ({ page, request }) => {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, unique('Phone control'), paths.checkout, new Date().toISOString())
  await db.close()
  expect((await apiData<Task>(request, `/tasks/${id}`)).seti_control).toBe('self')
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Access')
  const edit = page.getByRole('button', { name: 'Edit access' })
  await edit.scrollIntoViewIfNeeded()
  await edit.tap()
  const access = page.getByRole('dialog', { name: /^Access of / })
  const row = access.getByRole('region', { name: 'Seti control' })
  await expect(row).toContainText('Reads Seti and changes only itself')
  await expect(row).toBeInViewport()
  await expectFitsPhone(page, 'access dialog with Seti control')
  const levels = row.getByRole('group', { name: 'Seti control level' })
  await expect(levels.getByRole('button', { name: 'Self' })).toHaveAttribute('aria-pressed', 'true')
  await levels.getByRole('button', { name: 'Full' }).tap()
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
  await expect(levels.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true')
  await expect(row).toContainText('Runs Seti actions like the EA')
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).seti_control).toBe('full')
})
