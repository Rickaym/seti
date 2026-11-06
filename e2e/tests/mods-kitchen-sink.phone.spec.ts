import type { ModAsk, Task } from '@seti/shared'
import { apiData, expect, toasts } from './support/fixtures.js'
import { builderAgent, KITCHEN_SINK, sinkConnection } from './support/kitchen-sink.js'
import { fixtureCopy, installFolder, removeMod } from './support/mod-fixtures.js'
import { VIEW_CONSOLE_ERRORS, VIEW_HTTP_STATUSES, VIEW_VIOLATIONS } from './support/mod-views.js'
import { sinkTest as test } from './support/sink-upstream.js'

test.use({
  allowedCspViolations: VIEW_VIOLATIONS,
  allowedConsoleErrors: VIEW_CONSOLE_ERRORS,
  allowedHttpStatuses: VIEW_HTTP_STATUSES,
})

test.beforeEach(async ({ request }) => {
  await installFolder(request, fixtureCopy(KITCHEN_SINK), { SINK_TOKEN: await sinkConnection(request) })
})

test.afterEach(async ({ request }) => {
  await removeMod(request, KITCHEN_SINK)
})

test("on a phone the kitchen sink's view runs its command, and its ask is answered from the toast", async ({
  page,
  request,
}) => {
  await builderAgent(request)
  await page.goto(`/#${KITCHEN_SINK}.board`)
  const region = page.getByRole('region', { name: 'Kitchen sink mod: Sink' })
  await expect(region).toContainText('Kitchen sink')
  const frame = page.frameLocator('iframe[title="Kitchen sink: Sink"]')
  await expect(frame.locator('#theme')).toContainText('Theme light')
  await frame.getByRole('button', { name: 'Summarize' }).click()
  await expect(frame.locator('#result')).toContainText('Ran: Sink summary of Sink builder')
  const box = await region.boundingBox()
  expect(box?.width ?? 0).toBeGreaterThan((page.viewportSize()?.width ?? 0) - 2)

  const asked = await request.post(`/api/mods/${KITCHEN_SINK}/actions/ask-start`, { data: { args: {} } })
  expect(asked.status(), await asked.text()).toBe(200)
  await page.reload()
  const ask = toasts(page).filter({ hasText: 'Kitchen sink asks you' })
  await expect(ask).toContainText('Start an agent "Sink helper" with this prompt:', { timeout: 15_000 })
  await ask.getByRole('button', { name: 'Deny' }).click()
  await expect(ask).toHaveCount(0)
  expect((await apiData<ModAsk[]>(request, '/mod-asks')).filter((entry) => entry.mod_id === KITCHEN_SINK)).toEqual([])
  expect((await apiData<Task[]>(request, '/tasks')).some((task) => task.title === 'Sink helper')).toBe(false)
})
