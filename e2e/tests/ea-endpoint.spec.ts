import type { EaHealth } from '@seti/shared'
import { expect, test } from './support/fixtures.js'

const HEALTH: EaHealth = {
  ok: true,
  configured: true,
  missing: [],
  model: 'deployment-a',
  text_model: 'deployment-a',
  llm_api: 'responses',
  llm_host: 'models.example.test',
  chat_missing: [],
  turn: false,
}

test('the voice model line names the API and the host the EA talks to', async ({ page }) => {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: HEALTH }))
  await page.goto('/#settings/ea')
  await expect(page.getByTestId('ea-voice-model')).toHaveText('deployment-a, Responses at models.example.test')
})

test('a bot that does not say its API shows the model alone', async ({ page }) => {
  const older: EaHealth = { ...HEALTH, llm_api: undefined, llm_host: undefined }
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: older }))
  await page.goto('/#settings/ea')
  await expect(page.getByTestId('ea-voice-model')).toHaveText('deployment-a')
})
