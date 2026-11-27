import type { EaHealth } from '@seti/shared'
import { expect, test } from './support/fixtures.js'

const OLDER: EaHealth = {
  ok: true,
  configured: true,
  missing: [],
  model: 'deployment-a',
  text_model: 'deployment-a',
  chat_missing: [],
  turn: false,
}
const HEALTH: EaHealth = { ...OLDER, llm_api: 'responses', llm_host: 'models.example.test' }

test('the voice model line names the API and the host the EA talks to', async ({ page }) => {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: HEALTH }))
  await page.goto('/#settings/ea')
  await expect(page.getByTestId('ea-voice-model')).toHaveText('deployment-a, Responses at models.example.test')
})

test('a bot that does not say its API shows the model alone', async ({ page }) => {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: OLDER }))
  await page.goto('/#settings/ea')
  await expect(page.getByTestId('ea-voice-model')).toHaveText('deployment-a')
})
