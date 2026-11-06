import type { Page } from '@playwright/test'
import type { EaHealth } from '@seti/shared'
import { audioSpy, deviceId, spyOnAudio } from './support/audio.js'
import { fakeEa } from './support/fake-ea.js'
import { expect, test } from './support/fixtures.js'

test.use({ permissions: ['microphone'] })

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }

const eaItem = (page: Page) => page.getByRole('contentinfo').getByRole('group', { name: 'EA', exact: true })
const eaSheet = (page: Page) => page.getByRole('region', { name: 'EA call' })

const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test('the call sheet holds only the call buttons, and the settings switch the microphone mid-call', async ({
  page,
}) => {
  await spyOnAudio(page)
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  const { offers } = await fakeEa(page)
  await page.goto('/#agents')
  await eaItem(page).getByRole('button', { name: 'EA', exact: true }).tap()
  await eaSheet(page).getByRole('button', { name: 'Call', exact: true }).tap()
  await expect(eaSheet(page).getByTestId('ea-status')).toHaveText('Listening')
  const names = async () =>
    eaSheet(page)
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent))
  expect(await names()).toEqual(['EA settings', 'Close', 'Mute', 'Sleep', 'Hang up'])
  await expect(eaSheet(page).getByRole('combobox')).toHaveCount(0)

  await eaSheet(page).getByRole('button', { name: 'EA settings' }).tap()
  await expect(page).toHaveURL(/#settings\/ea$/)
  await expect(eaSheet(page)).toBeHidden()
  const mic = page
    .getByRole('main')
    .getByRole('region', { name: 'Audio' })
    .getByRole('combobox', { name: 'Microphone' })
  await mic.selectOption({ label: 'Fake Audio Input 2' })
  const second = await deviceId(page, 'Fake Audio Input 2')
  await expect.poll(async () => (await audioSpy(page)).sent.at(-1)).toBe(second)
  await expect(eaItem(page).getByTestId('ea-bar-status')).toHaveText('Listening')
  expect(offers).toHaveLength(1)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  await eaItem(page).getByRole('button', { name: 'EA call controls' }).tap()
  await eaSheet(page).getByRole('button', { name: 'Hang up', exact: true }).tap()
  await expect(eaSheet(page).getByRole('button', { name: 'Call', exact: true })).toBeVisible()
})

test('the EA page starts a call with thumb-sized buttons, and ending it there ends it everywhere', async ({ page }) => {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  const { offers } = await fakeEa(page)
  await page.goto('/#ea')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Call', exact: true }).tap()
  const card = main.getByRole('region', { name: 'Live call' })
  await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')
  await expect(eaItem(page).getByTestId('ea-bar-status')).toHaveText('Listening')
  const hangUp = card.getByRole('button', { name: 'Hang up', exact: true })
  expect((await hangUp.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  await hangUp.tap()
  await expect(card).toHaveCount(0)
  await expect(eaItem(page).getByTestId('ea-bar')).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Call', exact: true })).toBeVisible()
  expect(offers).toHaveLength(1)
})

test('the settings page keeps the audio section within a phone screen', async ({ page }) => {
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Audio' })
  await expect(card.getByRole('combobox', { name: 'Microphone' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Test speaker' })).toBeVisible()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})
