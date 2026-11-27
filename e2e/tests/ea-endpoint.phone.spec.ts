import type { EaHealth } from '@seti/shared'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const HEALTH: EaHealth = {
  ok: true,
  configured: true,
  missing: [],
  model: 'gpt-6-sol',
  text_model: 'gpt-6-sol',
  llm_api: 'chat',
  llm_host: 'a-long-resource-name-for-the-models.services.example.test',
  chat_missing: [],
  turn: true,
}

test('a long model host wraps inside a phone', async ({ page }) => {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: HEALTH }))
  await page.goto('/#settings/ea')
  const line = page.getByTestId('ea-voice-model')
  await expect(line).toHaveText(`gpt-6-sol, Chat Completions at ${HEALTH.llm_host ?? ''}`)
  await line.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'EA page with a long model host')
})
