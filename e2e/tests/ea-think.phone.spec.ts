import type { EaHealth } from '@seti/shared'
import { fakeEaChat, type FakeChat } from './support/fake-ea.js'
import { expect, test } from './support/fixtures.js'
import { askToThink, thinkingLine } from './support/think.js'

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }

let chat: FakeChat | null = null

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/ea/history')).ok()).toBe(true)
})

test.afterEach(async ({ request }) => {
  await chat?.close()
  chat = null
  await request.delete('/api/ea/history')
})

test('on a phone a typed think shows its Thinking line, then the answer', async ({ page, request }) => {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  chat = await fakeEaChat(page)
  await page.goto('/#ea')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'EA', level: 1 })).toBeVisible()

  await askToThink(page, chat, request, async (text) => {
    await main.getByRole('combobox', { name: 'Message the EA' }).fill(text)
    await main.getByRole('button', { name: 'Send' }).tap()
  })
  await expect(thinkingLine(page)).toHaveCount(0)
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(scroll).toBeLessThanOrEqual(0)
})
