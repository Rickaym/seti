import { randomUUID } from 'node:crypto'
import type { Task } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('the Bypass switch fits a phone and turns on and off with a tap', async ({ page, request }) => {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, unique('Phone bypass'), paths.checkout, new Date().toISOString())
  await db.close()

  await page.goto(`/#agents/${id}`)
  const panel = await openAgentSettings(page, 'Access')
  const bypass = panel.getByTestId('bypass')
  await bypass.scrollIntoViewIfNeeded()
  await expect(bypass).toBeInViewport()
  await expectFitsPhone(page, 'agent settings with Bypass')
  const toggle = bypass.getByRole('switch', { name: 'Bypass' })
  await expect(toggle).not.toBeChecked()
  await expect(bypass.getByRole('combobox', { name: 'Bypass duration' })).toHaveValue('8')
  await toggle.tap()
  await expect(toggle).toBeChecked()
  await expect(bypass).toContainText(/until \d{1,2}:\d{2}/)
  await expectFitsPhone(page, 'agent settings with Bypass on')
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).bypass_until).not.toBeNull()

  await toggle.tap()
  await expect(toggle).not.toBeChecked()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).bypass_until).toBeNull()
})
