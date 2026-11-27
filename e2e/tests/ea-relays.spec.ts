import type { AuditPage, EaSettings } from '@seti/shared'
import { READY, TOLD, relayedItem, setRelays } from './support/ea-relays.js'
import { apiData, expect, test } from './support/fixtures.js'

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/ea/history')).ok()).toBe(true)
  await setRelays(request, false)
})

test.afterEach(async ({ request }) => {
  await setRelays(request, false)
})

test('inbox relays start off and the user turns them on from the EA page', async ({ page, request }) => {
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Inbox' })
  const toggle = card.getByRole('button', { name: 'Relays' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(card).toContainText('Off, it asks you first.')
  await toggle.hover()
  await expect(page.getByRole('tooltip')).toContainText('in its own words, and tells you')
  await card.screenshot({ path: test.info().outputPath('relays-off.png') })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).inbox_relays).toBe(true)
  const audit = await apiData<AuditPage>(request, '/audit?kind=ea.inbox_relays&limit=1')
  expect(audit.events[0]).toMatchObject({ summary: 'Inbox relays on' })
  await card.screenshot({ path: test.info().outputPath('relays-on.png') })
})

test('a relayed item shows whom the EA told, and Take back stops it before the agent reads it', async ({
  page,
  request,
}) => {
  await relayedItem(request)
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.goto('/#ea')
  const transcript = page.getByRole('main').getByRole('region', { name: 'Transcript' })
  const relay = transcript.getByTestId('ea-relay')
  await expect(relay).toContainText('Told Release notes')
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
