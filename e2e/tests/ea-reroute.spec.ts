import type { Page } from '@playwright/test'
import type { EaHealth } from '@seti/shared'
import { announceDeviceChange, audioSpy, plugHeadset, spyOnAudio } from './support/audio.js'
import { callEnds } from './support/background.js'
import { fakeEa } from './support/fake-ea.js'
import { expect, test } from './support/fixtures.js'

test.use({ permissions: ['microphone'] })

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }
const SETTLED_MS = 2500

async function mockEa(page: Page) {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  return fakeEa(page)
}

const eaItem = (page: Page) => page.getByRole('contentinfo').getByRole('group', { name: 'EA', exact: true })
const status = (page: Page) => eaItem(page).getByTestId('ea-bar-status')
const sent = async (page: Page) => (await audioSpy(page)).sent
const voices = async (page: Page) => (await audioSpy(page)).voices

async function startCall(page: Page) {
  await eaItem(page).getByRole('button', { name: 'Start an EA call' }).click()
  await expect(status(page)).toHaveText('Listening')
  await expect.poll(async () => sent(page)).toEqual(['default'])
  await expect.poll(async () => voices(page)).toBeGreaterThan(0)
}

async function hangUp(page: Page) {
  await eaItem(page).getByTestId('ea-bar').hover()
  await eaItem(page).getByRole('region', { name: 'EA call' }).getByRole('button', { name: 'Hang up' }).click()
  await expect(status(page)).toHaveCount(0)
}

/** Every control sits inside the popover and nothing in it scrolls sideways. */
async function expectControlsFit(page: Page) {
  const details = eaItem(page).getByRole('region', { name: 'EA call' })
  const box = await details.boundingBox()
  expect(box?.width).toBe(320)
  expect(await details.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
  const buttons = await details.getByRole('button').all()
  expect(buttons).toHaveLength(5)
  for (const button of buttons) {
    const inner = await button.boundingBox()
    expect(inner?.x ?? 0).toBeGreaterThanOrEqual(box?.x ?? 0)
    expect((inner?.x ?? 0) + (inner?.width ?? 0)).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) - 12)
    expect(await button.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
  }
  const tops = await Promise.all(
    ['Mute', 'Sleep', 'Audio', 'Hang up'].map(
      async (name) => (await details.getByRole('button', { name, exact: true }).boundingBox())?.y,
    ),
  )
  expect(new Set(tops).size).toBe(1)
}

test('a headset that connects mid-call reopens the microphone once and keeps the call', async ({ page }) => {
  await spyOnAudio(page)
  const { offers } = await mockEa(page)
  const ends = callEnds(page)
  await page.goto('/#agents')
  await startCall(page)
  const played = await voices(page)

  await plugHeadset(page)
  await expect.poll(async () => sent(page)).toEqual(['default', 'default'])
  await expect.poll(async () => voices(page)).toBeGreaterThan(played)
  const from = await page.evaluate(() => Date.now())
  await announceDeviceChange(page)
  await expect.poll(async () => page.evaluate(() => Date.now())).toBeGreaterThan(from + SETTLED_MS)
  expect(await sent(page)).toHaveLength(2)
  await expect(status(page)).toHaveText('Listening')
  expect(offers).toHaveLength(1)

  await hangUp(page)
  await expect.poll(() => ends).toHaveLength(1)
  expect(ends[0]).toMatchObject({ reason: 'hang-up', inputs: ['default'], reroutes: 1 })
})

test('Audio fits the call details as an icon with a hint, and reopens the microphone and the voice', async ({
  page,
}) => {
  await spyOnAudio(page)
  const { offers } = await mockEa(page)
  const ends = callEnds(page)
  await page.goto('/#agents')
  await startCall(page)
  const played = await voices(page)

  await eaItem(page).getByTestId('ea-bar').hover()
  const details = eaItem(page).getByRole('region', { name: 'EA call' })
  await expectControlsFit(page)
  await details.getByRole('button', { name: 'Audio' }).hover()
  await expect(page.getByText('Move the call to your headset or the output in use now')).toBeVisible()
  await details.getByRole('button', { name: 'Audio' }).click()
  await expect.poll(async () => sent(page)).toEqual(['default', 'default'])
  await expect.poll(async () => voices(page)).toBeGreaterThan(played)
  await expect(status(page)).toHaveText('Listening')
  expect(offers).toHaveLength(1)

  await hangUp(page)
  await expect.poll(() => ends).toHaveLength(1)
  expect(ends[0]).toMatchObject({ reroutes: 1 })
})
