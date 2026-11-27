import type { EaSettings } from '@seti/shared'
import { READY, TOLD, relayedItem, setRelays } from './support/ea-relays.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/ea/history')).ok()).toBe(true)
  await setRelays(request, false)
})

test.afterEach(async ({ request }) => {
  await setRelays(request, false)
})

test('the inbox relays switch fits a phone and turns on with a tap', async ({ page, request }) => {
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Inbox' })
  const toggle = card.getByRole('button', { name: 'Relays' })
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expectFitsPhone(page, 'EA page with inbox relays off')
  await page.screenshot({ path: test.info().outputPath('phone-relays-off.png') })
  await toggle.tap()
  await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).inbox_relays).toBe(true)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
})

test('a relay line with Take back fits a phone and takes a tap', async ({ page, request }) => {
  await relayedItem(request, 'Release notes')
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.goto('/#ea')
  const transcript = page.getByRole('main').getByRole('region', { name: 'Transcript' })
  const relay = transcript.getByTestId('ea-relay')
  await expect(relay).toContainText('Told Release notes')
  await expect(transcript).toContainText(TOLD)
  const takeBack = relay.getByRole('button', { name: 'Take back' })
  expect((await takeBack.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'EA chat with a relay line')
  await page.screenshot({ path: test.info().outputPath('phone-relay-told.png') })
  await takeBack.tap()
  await expect(relay).toContainText('Took back from Release notes')
})
