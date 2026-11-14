import type { Page } from '@playwright/test'
import type { EaHealth } from '@seti/shared'
import {
  backgroundable,
  callEnds,
  longestGap,
  mediaSession,
  pressMediaAction,
  toBackground,
} from './support/background.js'
import { botLeaves, botPings, botSays, fakeEa } from './support/fake-ea.js'
import { expect, test } from './support/fixtures.js'

test.use({ permissions: ['microphone'] })

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }
const AWAY_MS = 4500

async function mockEa(page: Page) {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  return fakeEa(page)
}

const eaItem = (page: Page) => page.getByRole('contentinfo').getByRole('group', { name: 'EA', exact: true })
const status = (page: Page) => eaItem(page).getByTestId('ea-bar-status')

async function startCall(page: Page) {
  await page.goto('/#agents')
  await eaItem(page).getByRole('button', { name: 'Start an EA call' }).click()
  await expect(status(page)).toHaveText('Listening')
}

test('a call keeps pinging the EA in the background, and the media controls mute and hang up', async ({ page }) => {
  await backgroundable(page)
  await mockEa(page)
  const ends = callEnds(page)
  await startCall(page)
  expect(await mediaSession(page)).toEqual({ title: 'EA call', state: 'playing' })

  const from = await page.evaluate(() => Date.now())
  await toBackground(page)
  await expect.poll(async () => page.evaluate(() => Date.now())).toBeGreaterThan(from + AWAY_MS)
  const to = await page.evaluate(() => Date.now())
  expect(longestGap(await botPings(page), from, to)).toBeLessThan(3000)
  await expect(status(page)).toHaveText('Listening')
  expect(await mediaSession(page)).toEqual({ title: 'EA call', state: 'playing' })

  await pressMediaAction(page, 'togglemicrophone')
  await expect.poll(async () => (await mediaSession(page)).state).toBe('paused')
  await pressMediaAction(page, 'hangup')
  await expect(status(page)).toHaveCount(0)
  expect(await mediaSession(page)).toEqual({ title: null, state: 'none' })
  await expect.poll(() => ends).toHaveLength(1)
  expect(ends[0]).toMatchObject({ reason: 'hang-up', auto: false, hidden: true })
  expect(ends[0]?.hidden_s).toBeGreaterThanOrEqual(4)

  await toBackground(page, false)
  await page.goto('/#settings/ea')
  await expect(page.getByTestId('ea-last-end')).toHaveText('Hung up, in the background')
})

test('a call the EA ends on its own is recorded with its reason', async ({ page }) => {
  await mockEa(page)
  const ends = callEnds(page)
  await startCall(page)
  await botSays(page, 'server-message', { type: 'ea-call-end', reason: 'bot-idle' })
  await botLeaves(page)
  await expect(status(page)).toHaveCount(0)
  await expect.poll(() => ends).toHaveLength(1)
  expect(ends[0]).toMatchObject({ reason: 'bot-idle', hidden: false, hidden_s: null })
})

test('a page that closes during a call reports it', async ({ page, request }) => {
  await mockEa(page)
  const closed = async () => {
    const res = await request.get('/api/audit?kind=ea.call_ended')
    const { events } = ((await res.json()) as { data: { events: { detail: { reason?: string } }[] } }).data
    return events.filter((event) => event.detail.reason === 'page-closed').length
  }
  const before = await closed()
  await startCall(page)
  await page.reload()
  await expect(eaItem(page)).toBeVisible()
  await expect.poll(closed).toBe(before + 1)
})
