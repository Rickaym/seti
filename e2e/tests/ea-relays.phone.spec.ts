import type { EaSettings } from '@seti/shared'
import { READY, TOLD, relayedItem, setRelays, skipAgent, startedItem } from './support/ea-relays.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/ea/history')).ok()).toBe(true)
  await setRelays(request, false)
})

test.afterEach(async ({ request }) => {
  await setRelays(request, false)
})

test('the Assign switch fits a phone and turns on with a tap', async ({ page, request }) => {
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Inbox' })
  const toggle = card.getByRole('button', { name: 'Assign' })
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expectFitsPhone(page, 'EA page with Assign off')
  await page.screenshot({ path: test.info().outputPath('phone-relays-off.png') })
  await toggle.tap()
  await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).inbox_relays).toBe(true)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
})

test('an assigned line with Take back fits a phone and takes a tap', async ({ page, request }) => {
  await relayedItem(request, 'Release notes')
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.goto('/#ea')
  const transcript = page.getByRole('main').getByRole('region', { name: 'Transcript' })
  const relay = transcript.getByTestId('ea-relay')
  await expect(relay).toContainText('Assigned Release notes')
  await expect(transcript).toContainText(TOLD)
  const takeBack = relay.getByRole('button', { name: 'Take back' })
  expect((await takeBack.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'EA chat with a relay line')
  await page.screenshot({ path: test.info().outputPath('phone-relay-told.png') })
  await takeBack.tap()
  await expect(relay).toContainText('Took back from Release notes')
})

test('a started line and a skipped agent fit a phone with 44 px buttons', async ({ page, request }) => {
  await startedItem(request)
  await skipAgent(request, 'Humbaba')
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.goto('/#ea')
  const line = page.getByRole('main').getByRole('region', { name: 'Transcript' }).getByTestId('ea-relay')
  await expect(line).toContainText('Started BES latency')
  expect((await line.getByRole('button', { name: 'Stop' }).boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'EA chat with a started line')
  await page.screenshot({ path: test.info().outputPath('phone-assign-started.png') })

  await page.goto('/#settings/ea')
  const skip = page.getByRole('main').getByRole('button', { name: 'Remove: Not to Humbaba' })
  await skip.scrollIntoViewIfNeeded()
  expect((await skip.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'EA page with a skipped agent')
  await page.screenshot({ path: test.info().outputPath('phone-assign-skips.png') })
  await skip.tap()
  await expect(page.getByTestId('ea-assign-skip')).toHaveCount(0)
})
