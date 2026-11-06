import {
  claimAnswers,
  clearEaReplies,
  eaAsks,
  eaReplies,
  eaToast,
  REPLY_TOAST_MS,
  unseenCount,
} from './support/ea-replies.js'
import { expect, nextApiResponse, test, unique } from './support/fixtures.js'

/** Sonner's own toasts time out after four seconds; EA replies must outlast that. */
const PAST_A_NORMAL_TOAST_MS = 6000
/** Past the ten-second poll of unseen EA messages. */
const NEXT_POLL_MS = 11_000

test.beforeEach(async ({ request }) => {
  await clearEaReplies(request)
})

test.afterEach(async ({ request }) => {
  await clearEaReplies(request)
})

test('an EA reply with no call stays as a toast until dismissed, which marks it seen', async ({ page, request }) => {
  await page.clock.install()
  await page.goto('/#agents')
  const text = unique('Two agents run')
  await eaReplies(request, `**${text}**, one waits on you.`)
  const toast = eaToast(page, text)
  await expect(toast).toBeVisible({ timeout: REPLY_TOAST_MS })
  await expect(toast.locator('strong')).toHaveText(text)
  await expect(toast).not.toContainText('**')
  await expect(toast.getByRole('button', { name: 'Open' })).toHaveCount(0)
  await page.clock.fastForward(PAST_A_NORMAL_TOAST_MS)
  await expect(toast).toBeVisible()

  await toast.getByRole('button', { name: 'Close toast' }).click()
  await expect(toast).toBeHidden()
  await expect.poll(async () => unseenCount(request)).toBe(0)
})

test('a long reply reads in normal weight and More shows all of it', async ({ page, request }) => {
  await page.goto('/#agents')
  const text = unique('Long report')
  const lines = Array.from({ length: 14 }, (_, i) => `- Line ${String(i + 1)} of the report`)
  await eaReplies(request, [text, '', ...lines].join('\n'))
  const toast = eaToast(page, text)
  await expect(toast).toBeVisible({ timeout: REPLY_TOAST_MS })
  const weight = await toast.getByText(text).evaluate((el) => getComputedStyle(el).fontWeight)
  expect(Number(weight)).toBeLessThan(500)
  await toast.getByRole('button', { name: 'More' }).click()
  const full = page.getByRole('dialog', { name: 'EA' })
  const last = full.getByText('Line 14 of the report')
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()
  await expect(page).toHaveURL(/#agents$/)
  await full.getByRole('button', { name: 'Open chat' }).click()
  await expect(page).toHaveURL(/#ea$/)
  await expect.poll(async () => unseenCount(request)).toBe(0)
})

test('tapping the reply goes to the EA chat, which marks it seen', async ({ page, request }) => {
  await page.goto('/#context')
  const text = unique('The PR is green')
  await eaReplies(request, text)
  const toast = eaToast(page, text)
  await toast.getByText(text).click({ timeout: REPLY_TOAST_MS })
  await expect(page).toHaveURL(/#ea$/)
  await expect(toast).toBeHidden()
  await expect(page.getByRole('main')).toContainText(text)
  await expect.poll(async () => unseenCount(request)).toBe(0)
})

test('Allow answers its exact question once, and Deny another, never twice', async ({ page, request }) => {
  await page.goto('/#agents')
  const allowed = await eaAsks(request, 'delete agent Old login', unique('k-allow'))
  const denied = await eaAsks(request, 'archive agent Docs', unique('k-deny'))
  await eaReplies(request, 'That deletes Old login. Shall I go ahead?', [allowed.id])
  await eaReplies(request, 'That archives Docs. Shall I go ahead?', [denied.id])

  const first = eaToast(page, 'deletes Old login')
  const second = eaToast(page, 'archives Docs')
  await expect(second).toBeVisible({ timeout: REPLY_TOAST_MS })
  await second.hover()
  await first.getByRole('button', { name: 'Allow: Delete agent Old login' }).click()
  await expect(first.getByRole('status')).toHaveText('Allowed')
  await expect(first.getByRole('button', { name: 'Allow: Delete agent Old login' })).toBeDisabled()
  await expect(first.getByRole('button', { name: 'Deny: Delete agent Old login' })).toBeDisabled()

  await second.getByRole('button', { name: 'Deny: Archive agent Docs' }).click()
  await expect(second.getByRole('status')).toHaveText('Denied')

  const answers = await claimAnswers(request)
  expect(answers.map((a) => [a.id, a.decision])).toEqual([
    [allowed.id, 'allow'],
    [denied.id, 'deny'],
  ])
  expect(await claimAnswers(request)).toEqual([])
  const again = await request.post(`/api/ea/asks/${String(allowed.id)}/decision`, { data: { decision: 'allow' } })
  expect(again.status()).toBe(409)
})

test('no toast while the EA chat is open; it marks what it shows seen', async ({ page, request }) => {
  await page.goto('/#ea')
  await expect(page.getByRole('heading', { name: 'EA', level: 1 })).toBeAttached()
  const text = unique('Nothing is on fire')
  await eaReplies(request, text)
  await expect(page.getByRole('main')).toContainText(text, { timeout: REPLY_TOAST_MS })
  await expect.poll(async () => unseenCount(request), { timeout: REPLY_TOAST_MS }).toBe(0)
  await expect(eaToast(page, text)).toHaveCount(0)
})

test('the Active tier set to Brief keeps EA replies out of toasts', async ({ page, request }) => {
  await page.clock.install()
  await page.goto('/#settings/notifications')
  const active = page.getByRole('main').getByRole('combobox', { name: 'Active tier' })
  await expect(active).toHaveText('Push')
  await active.click()
  await page.getByRole('option', { name: 'Brief' }).click()
  await expect(active).toHaveText('Brief')
  const text = unique('Quiet reply')
  await eaReplies(request, text)
  const polled = nextApiResponse(page, 'GET', '/ea/replies')
  await page.clock.fastForward(NEXT_POLL_MS)
  expect(JSON.stringify(await (await polled).json())).toContain(text)
  await expect(eaToast(page, text)).toHaveCount(0)

  await active.click()
  await page.getByRole('option', { name: 'Toast' }).click()
  await expect(eaToast(page, text)).toBeVisible()
})
