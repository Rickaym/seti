import {
  claimAnswers,
  clearEaReplies,
  eaAsks,
  eaReplies,
  eaToast,
  REPLY_TOAST_MS,
  unseenCount,
} from './support/ea-replies.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.beforeEach(async ({ request }) => {
  await clearEaReplies(request)
})

test.afterEach(async ({ request }) => {
  await clearEaReplies(request)
})

test('on a phone an EA reply stays as a toast and its Allow answers the question once', async ({ page, request }) => {
  await page.goto('/#agents')
  const text = unique('Your CI is green')
  await eaReplies(request, text)
  const reply = eaToast(page, text)
  await expect(reply).toBeVisible({ timeout: REPLY_TOAST_MS })
  await reply.getByRole('button', { name: 'Close toast' }).click()
  await expect(reply).toBeHidden()
  await expect.poll(async () => unseenCount(request)).toBe(0)

  const ask = await eaAsks(request, 'delete agent Old phone', unique('k-phone'))
  await eaReplies(request, 'That deletes Old phone. Shall I go ahead?', [ask.id])
  const question = eaToast(page, 'deletes Old phone')
  const allow = question.getByRole('button', { name: 'Allow: Delete agent Old phone' })
  await allow.tap({ timeout: REPLY_TOAST_MS })
  await expect(question.getByRole('status')).toHaveText('Allowed')
  await expect(allow).toBeDisabled()
  expect((await claimAnswers(request)).map((a) => [a.id, a.decision])).toEqual([[ask.id, 'allow']])
})

test('on a phone an EA reply renders markdown and a tap on it opens the EA chat', async ({ page, request }) => {
  await page.goto('/#agents')
  const text = unique('Deploy is live')
  await eaReplies(request, `- **${text}**\n- nothing waits`)
  const reply = eaToast(page, text)
  await expect(reply.locator('li strong')).toHaveText(text, { timeout: REPLY_TOAST_MS })
  await reply.getByText(text).tap()
  await expect(page).toHaveURL(/#ea$/)
  await expect(reply).toBeHidden()
  await expect.poll(async () => unseenCount(request)).toBe(0)
})

test('on a phone More shows a long reply whole, fitting the screen', async ({ page, request }) => {
  await page.goto('/#agents')
  const text = unique('Phone long')
  const lines = Array.from({ length: 30 }, (_, i) => `- Phone line ${String(i + 1)}`)
  await eaReplies(request, [text, '', ...lines].join('\n'))
  const toast = eaToast(page, text)
  await toast.getByRole('button', { name: 'More' }).tap({ timeout: REPLY_TOAST_MS })
  const full = page.getByRole('dialog', { name: 'EA' })
  await expect(full).toBeVisible()
  await expectFitsPhone(page, 'full EA reply')
  const last = full.getByText('Phone line 30')
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()
  await expect(full.getByRole('button', { name: 'Open chat' })).toBeInViewport()
  await expect(page).toHaveURL(/#agents$/)
})

test('on a phone the open EA chat raises no toast', async ({ page, request }) => {
  await page.goto('/#ea')
  const text = unique('Quiet on the phone')
  await eaReplies(request, text)
  await expect(page.getByRole('main')).toContainText(text, { timeout: REPLY_TOAST_MS })
  await expect.poll(async () => unseenCount(request), { timeout: REPLY_TOAST_MS }).toBe(0)
  await expect(eaToast(page, text)).toHaveCount(0)
})
