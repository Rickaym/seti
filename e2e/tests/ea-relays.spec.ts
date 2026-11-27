import type { AuditPage, EaSettings } from '@seti/shared'
import { READY, TOLD, relayedItem, setRelays, skipAgent, startedItem } from './support/ea-relays.js'
import { apiData, expect, test } from './support/fixtures.js'

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/ea/history')).ok()).toBe(true)
  await setRelays(request, false)
})

test.afterEach(async ({ request }) => {
  await setRelays(request, false)
})

test('Assign starts off and the user turns it on from the EA page', async ({ page, request }) => {
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Inbox' })
  const toggle = card.getByRole('button', { name: 'Assign' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(card).toContainText('Sensitive work still asks')
  await toggle.hover()
  await expect(page.getByRole('tooltip')).toContainText('without asking, and tells you in a line')
  await card.screenshot({ path: test.info().outputPath('relays-off.png') })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).inbox_relays).toBe(true)
  const audit = await apiData<AuditPage>(request, '/audit?kind=ea.inbox_relays&limit=1')
  expect(audit.events[0]).toMatchObject({ summary: 'Assign on' })
  await card.screenshot({ path: test.info().outputPath('relays-on.png') })
})

test('an assigned item shows whom the EA gave it, and Take back stops it before the agent reads it', async ({
  page,
  request,
}) => {
  await relayedItem(request)
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.goto('/#ea')
  const transcript = page.getByRole('main').getByRole('region', { name: 'Transcript' })
  const relay = transcript.getByTestId('ea-relay')
  await expect(relay).toContainText('Assigned Release notes')
  await expect(transcript).toContainText(TOLD)
  await transcript.locator('[data-kind="notice"]').screenshot({ path: test.info().outputPath('relay-told.png') })

  await relay.getByRole('button', { name: 'Take back' }).click()
  await expect(relay).toContainText('Took back from Release notes')
  await expect(relay.getByRole('button', { name: 'Take back' })).toHaveCount(0)
  const audit = await apiData<AuditPage>(request, '/audit?kind=ea.relay_taken_back&limit=1')
  expect(audit.events[0]).toMatchObject({ summary: `Took back the EA's relay to "Release notes"` })
  await page.reload()
  await expect(relay).toContainText('Took back from Release notes')
})

test('a started agent shows Started with Stop, and a skipped agent is removed from the EA page', async ({
  page,
  request,
}) => {
  await startedItem(request)
  await skipAgent(request, 'Humbaba')
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/tasks/*/stop', async (route) => route.fulfill({ json: { data: {} } }))
  await page.goto('/#ea')
  const transcript = page.getByRole('main').getByRole('region', { name: 'Transcript' })
  const line = transcript.getByTestId('ea-relay')
  await expect(line).toContainText('Started BES latency')
  await transcript.locator('[data-kind="notice"]').screenshot({ path: test.info().outputPath('assign-started.png') })
  await line.getByRole('button', { name: 'Stop' }).click()
  await expect(line).toContainText('Started and stopped BES latency')

  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Inbox' })
  const skip = card.getByRole('button', { name: 'Remove: Not to Humbaba' })
  await expect(skip).toBeVisible()
  await card.screenshot({ path: test.info().outputPath('assign-skips.png') })
  await skip.click()
  await expect(card.getByTestId('ea-assign-skip')).toHaveCount(0)
  const audit = await apiData<AuditPage>(request, '/audit?kind=ea.assign_skip_removed&limit=1')
  expect(audit.events[0]).toMatchObject({ summary: 'EA may assign to "Humbaba" again' })
})
