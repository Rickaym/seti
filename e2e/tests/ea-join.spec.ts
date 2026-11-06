import type { Page } from '@playwright/test'
import type { EaHealth, EaSettings } from '@seti/shared'
import { botSays, fakeEa } from './support/fake-ea.js'
import { apiData, expect, test } from './support/fixtures.js'

test.use({ permissions: ['microphone'] })

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }
const WAKE_ON = { wake_enabled: true, wake_phrase: 'Hey Seti', keep_awake_seconds: 30, join_on_open: true }
const WAKE_OFF = { ...WAKE_ON, wake_enabled: false }
const LOCAL_HINT = 'Listening locally: no speech to text until the phrase'

/** A running bot with its ICE servers, and a fake that answers each offer the page makes. */
async function readyEa(page: Page) {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  return fakeEa(page)
}

const eaItem = (page: Page) => page.getByRole('contentinfo').getByRole('group', { name: 'EA', exact: true })

const autoOffer = (body: unknown) => (body as { requestData?: { auto?: boolean } }).requestData?.auto === true

test.beforeEach(async ({ request }) => {
  expect((await request.put('/api/ea/settings', { data: WAKE_ON })).ok()).toBe(true)
})

test.afterEach(async ({ request }) => {
  await request.put('/api/ea/settings', { data: WAKE_OFF })
})

test('Seti joins the EA asleep when it opens, and one tab of the browser holds the call', async ({ page, context }) => {
  const { offers } = await readyEa(page)
  await page.goto('/#context')
  await expect.poll(() => offers.length).toBe(1)
  expect(autoOffer(offers[0]?.postDataJSON())).toBe(true)
  const item = eaItem(page)
  const status = item.getByTestId('ea-bar-status')
  await expect(status).toHaveText('Listening')
  await botSays(page, 'server-message', {
    type: 'ea-wake',
    enabled: true,
    awake: false,
    phrase: 'Hey Seti',
    local: true,
  })
  await expect(status).toHaveText('Say "Hey Seti"')
  await expect(status).toHaveAttribute('title', LOCAL_HINT)
  await expect(item.getByTestId('ea-light')).toHaveAttribute('data-wake', 'asleep')

  const second = await context.newPage()
  const later = await readyEa(second)
  await second.goto('/#context')
  await expect(eaItem(second).getByRole('button', { name: 'Start an EA call' })).toBeVisible()
  await expect(eaItem(second).getByTestId('ea-listen-prompt')).toHaveCount(0)
  const waiting = async () => second.evaluate(async () => (await navigator.locks.query()).pending?.length ?? 0)
  await expect.poll(waiting).toBe(1)
  await expect(eaItem(second)).toHaveAttribute('data-join', 'off')
  expect(later.offers).toHaveLength(0)

  await page.close()
  await expect.poll(() => later.offers.length).toBe(1)
  expect(autoOffer(later.offers[0]?.postDataJSON())).toBe(true)
  await expect(eaItem(second).getByTestId('ea-bar')).toBeVisible()
  await second.close()
})

test('a hang-up keeps the tab from rejoining, and Join on open off ends the joined call', async ({ page, request }) => {
  const { offers } = await readyEa(page)
  await page.goto('/#settings/ea')
  await expect.poll(() => offers.length).toBe(1)
  const item = eaItem(page)
  await item.getByRole('button', { name: 'Hang up the EA call' }).click()
  await expect(item.getByRole('button', { name: 'Start an EA call' })).toBeVisible()
  await expect(item).toHaveAttribute('data-join', 'held')
  expect(offers).toHaveLength(1)

  await page.reload()
  await expect.poll(() => offers.length).toBe(2)
  await expect(item.getByTestId('ea-bar')).toBeVisible()
  const wake = page.getByRole('main').getByRole('group', { name: 'Wake word' })
  const join = wake.getByRole('button', { name: 'Join on open' })
  await expect(join).toHaveAttribute('aria-pressed', 'true')
  await join.click()
  await expect(join).toHaveAttribute('aria-pressed', 'false')
  await expect(item.getByRole('button', { name: 'Start an EA call' })).toBeVisible()
  await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).join_on_open).toBe(false)

  await join.click()
  await expect(join).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => offers.length).toBe(3)
  await wake.getByRole('button', { name: 'Wake word' }).click()
  await expect(join).toBeDisabled()
  await expect(join).toHaveAttribute('aria-pressed', 'false')
  await expect(item.getByRole('button', { name: 'Start an EA call' })).toBeVisible()
  expect(offers).toHaveLength(3)
})

test('the status bar asks for a click while the browser has not allowed the microphone', async ({ page, context }) => {
  await context.clearPermissions()
  const { offers } = await readyEa(page)
  await page.goto('/#context')
  const prompt = eaItem(page).getByTestId('ea-listen-prompt')
  await expect(prompt).toHaveText('Click to let the EA listen')
  expect(offers).toHaveLength(0)
  await prompt.click()
  await expect.poll(() => offers.length).toBe(1)
  expect(autoOffer(offers[0]?.postDataJSON())).toBe(true)
  await expect(prompt).toHaveCount(0)
  await expect(eaItem(page).getByTestId('ea-bar')).toBeVisible()
})
