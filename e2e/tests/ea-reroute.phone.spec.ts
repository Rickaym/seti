import type { Page } from '@playwright/test'
import type { EaHealth } from '@seti/shared'
import { audioSpy, plugHeadset, spyOnAudio } from './support/audio.js'
import { fakeEa } from './support/fake-ea.js'
import { expect, test } from './support/fixtures.js'
import { expectTouchTarget } from './support/phone-layout.js'

test.use({ permissions: ['microphone'] })

const NARROW_PHONE = 340
const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }

async function mockEa(page: Page) {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  return fakeEa(page)
}

const eaItem = (page: Page) => page.getByRole('contentinfo').getByRole('group', { name: 'EA', exact: true })
const eaSheet = (page: Page) => page.getByRole('region', { name: 'EA call' })
const sent = async (page: Page) => (await audioSpy(page)).sent
const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

async function expectButtonsInside(page: Page) {
  const sheet = await eaSheet(page).boundingBox()
  for (const button of await eaSheet(page).getByRole('button').all()) {
    const box = await button.boundingBox()
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual((sheet?.x ?? 0) + (sheet?.width ?? 0) + 1)
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
}

test('a headset that connects and Audio in the call sheet both move the call without a reconnect', async ({ page }) => {
  await spyOnAudio(page)
  const { offers } = await mockEa(page)
  await page.goto('/#agents')
  await eaItem(page).getByRole('button', { name: 'EA', exact: true }).tap()
  await eaSheet(page).getByRole('button', { name: 'Call', exact: true }).tap()
  await expect(eaSheet(page).getByTestId('ea-status')).toHaveText('Listening')
  await expect.poll(async () => sent(page)).toEqual(['default'])

  const reroute = eaSheet(page).getByRole('button', { name: 'Audio', exact: true })
  await expectTouchTarget(reroute)
  await expectButtonsInside(page)
  const size = page.viewportSize()
  await page.setViewportSize({ width: NARROW_PHONE, height: size?.height ?? 800 })
  await expectButtonsInside(page)
  await page.setViewportSize(size ?? { width: 393, height: 800 })

  await plugHeadset(page)
  await expect.poll(async () => sent(page)).toEqual(['default', 'default'])
  await reroute.tap()
  await expect.poll(async () => sent(page)).toEqual(['default', 'default', 'default'])
  await expect(eaSheet(page).getByTestId('ea-status')).toHaveText('Listening')
  expect(offers).toHaveLength(1)
})

test('on Android a saved phone microphone gives way to a Bluetooth headset', async ({ page }, info) => {
  test.skip(info.project.name !== 'pixel-7', 'Only Chrome on Android ties the output to the microphone')
  await spyOnAudio(page)
  await mockEa(page)
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Audio' })
  const mic = card.getByRole('combobox', { name: 'Microphone' })
  await mic.selectOption({ label: 'Fake Audio Input 1' })
  await plugHeadset(page)
  await expect(card.getByTestId('ea-mic-note')).toHaveText(
    'Fake Audio Input 1 gives way to the Bluetooth headset while it is connected.',
  )
  await expect(mic.locator('option:checked')).toHaveText('System default')

  await eaItem(page).getByRole('button', { name: 'EA', exact: true }).tap()
  await eaSheet(page).getByRole('button', { name: 'Call', exact: true }).tap()
  await expect(eaSheet(page).getByTestId('ea-status')).toHaveText('Listening')
  await expect.poll(async () => sent(page)).toEqual(['default'])
  expect((await audioSpy(page)).requests.at(-1)).not.toHaveProperty('deviceId')
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})
