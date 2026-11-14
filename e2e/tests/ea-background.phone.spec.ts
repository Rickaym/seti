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
import { botPings, fakeEa } from './support/fake-ea.js'
import { expect, test } from './support/fixtures.js'

test.use({ permissions: ['microphone'] })

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
  await expect(eaItem(page).getByTestId('ea-bar')).toHaveCount(0)
})
