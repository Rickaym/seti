import { randomUUID } from 'node:crypto'
import type { Task } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'

const HOUR_MS = 3_600_000

test('Bypass is off by default, turns on for the chosen hours with a header badge, and turns off', async ({
  page,
  request,
}) => {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, unique('Bypass'), paths.checkout, new Date().toISOString())
  await db.close()
  expect((await apiData<Task>(request, `/tasks/${id}`)).bypass_until).toBeNull()

  await page.goto(`/#agents/${id}`)
  const panel = await openAgentSettings(page, 'Access')
  const bypass = panel.getByTestId('bypass')
  await expect(bypass).toContainText('Runs any tool without asking.')
  await bypass.getByRole('button', { name: 'About Bypass' }).click()
  await expect(page.getByRole('dialog').filter({ hasText: "Seti's guards" })).toContainText(
    "Runs every tool without asking for the hours you pick, then turns off by itself. Ask rules stop asking; deny rules, Seti's guards and the sandbox still apply.",
  )
  await page.keyboard.press('Escape')
  const toggle = bypass.getByRole('switch', { name: 'Bypass' })
  const duration = bypass.getByRole('combobox', { name: 'Bypass duration' })
  await expect(toggle).not.toBeChecked()
  await expect(duration).toHaveValue('8')
  await duration.selectOption('2')
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(bypass).toContainText(/until \d{1,2}:\d{2}/)
  await expect(duration).toBeHidden()

  const until = (await apiData<Task>(request, `/tasks/${id}`)).bypass_until ?? ''
  const left = Date.parse(until) - Date.now()
  expect(left).toBeGreaterThan(1.9 * HOUR_MS)
  expect(left).toBeLessThanOrEqual(2 * HOUR_MS)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('main').getByTitle(/^Bypass until /)).toBeVisible()

  await openAgentSettings(page, 'Access')
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(duration).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).bypass_until).toBeNull()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('main').getByTitle(/^Bypass until /)).toBeHidden()
})
