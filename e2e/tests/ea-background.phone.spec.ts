import type { Page } from '@playwright/test'
import type { EaHealth } from '@seti/shared'
import {
  backgroundable,
  callEnds,
  dropMic,
  longestGap,
  mediaSession,
  micTracks,
  notifications,
  phoneHooks,
  pressMediaAction,
  pressNotice,
  shownNotices,
  toBackground,
} from './support/background.js'
import { botPings, fakeEa } from './support/fake-ea.js'
import { expect, test } from './support/fixtures.js'

test.use({ permissions: ['microphone'] })

const CALL_AUDIO = /^\d+(\.\d)?% lost, \d+(\.\d)? s filled in, direct over UDP$/

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }

const eaItem = (page: Page) => page.getByRole('contentinfo').getByRole('group', { name: 'EA', exact: true })

test('a phone call stays live after switching apps, and the media controls hang it up', async ({ page }) => {
  await backgroundable(page)
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  await fakeEa(page)
  const ends = callEnds(page)
  await page.goto('/#ea')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Call', exact: true }).tap()
  const card = main.getByRole('region', { name: 'Live call' })
  await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')

  const from = await page.evaluate(() => Date.now())
  await toBackground(page)
  await expect.poll(async () => page.evaluate(() => Date.now())).toBeGreaterThan(from + 4500)
  const to = await page.evaluate(() => Date.now())
  expect(longestGap(await botPings(page), from, to)).toBeLessThan(3000)
  await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')
  expect(await mediaSession(page)).toEqual({ title: 'EA call', state: 'playing' })

  await pressMediaAction(page, 'pause')
  await expect(card.getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await pressMediaAction(page, 'play')
  await expect(card.getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await pressMediaAction(page, 'stop')
  await expect(card).toHaveCount(0)
  await expect.poll(() => ends).toHaveLength(1)
  expect(ends[0]).toMatchObject({ reason: 'hang-up', hidden: true })

  await toBackground(page, false)
  await page.goto('/#settings/ea')
  await expect(page.getByTestId('ea-last-end')).toHaveText('Hung up, in the background')
  await expect(page.getByTestId('ea-call-audio')).toHaveText(CALL_AUDIO)
  await expect(eaItem(page).getByTestId('ea-bar')).toHaveCount(0)
})

test('a phone call says the EA cannot hear it in the background, and reopens a dropped microphone', async ({
  page,
}) => {
  await backgroundable(page)
  await phoneHooks(page)
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  await fakeEa(page)
  await page.goto('/#ea')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Call', exact: true }).tap()
  const card = main.getByRole('region', { name: 'Live call' })
  await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')
  await expect(card).toContainText('The EA cannot hear you while Seti is in the background on this device')
  await page.screenshot({ path: test.info().outputPath('background-line.png') })

  const from = await page.evaluate(() => Date.now())
  await toBackground(page)
  const opened = await dropMic(page)
  await expect.poll(async () => page.evaluate(() => Date.now())).toBeGreaterThan(from + 5500)
  await toBackground(page, false)
  await expect(page.getByText(/^You were away for \d+ s; the EA could not hear you$/)).toBeVisible()
  await expect.poll(async () => (await micTracks(page)).live).toBe(true)
  expect((await micTracks(page)).count).toBeGreaterThan(opened)
  await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')
  await page.screenshot({ path: test.info().outputPath('away-note.png') })
})

test('an Android call shows a notification whose Hang up ends the call', async ({ page }) => {
  test.skip(!(await page.evaluate(() => navigator.userAgent.includes('Android'))), 'Android shows it')
  await notifications(page)
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  await fakeEa(page)
  await page.goto('/#ea')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Call', exact: true }).tap()
  const card = main.getByRole('region', { name: 'Live call' })
  await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')
  await expect.poll(async () => shownNotices(page)).toEqual(['Call with the EA: Microphone on'])

  await pressNotice(page, 'ea-mute')
  await expect.poll(async () => shownNotices(page)).toEqual(['Call with the EA: Muted'])
  await pressNotice(page, 'ea-hang-up')
  await expect(card).toHaveCount(0)
  await expect.poll(async () => shownNotices(page)).toEqual([])
})
