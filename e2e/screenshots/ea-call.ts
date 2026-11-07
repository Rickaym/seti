import type { Locator, Page } from '@playwright/test'
import { botSays, fakeEa } from '../tests/support/fake-ea.js'
import { expect } from '../tests/support/fixtures.js'

const QUESTION = 'Did the checkout PR pass CI?'
const ANSWER =
  'Yes, pull request 482 is green. Two review threads still ask for a test of the third timeout. ' +
  'Should the checkout agent take them?'

/** Calls the EA from its page through a bot faked inside the page, and returns the call card. */
async function callEa(page: Page): Promise<Locator> {
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  await fakeEa(page)
  await page.goto('/#ea')
  const main = page.getByRole('main')
  await expect(main.getByText('Tell the cart agent to take the second fix.')).toBeVisible()
  await main.getByRole('button', { name: 'Call', exact: true }).click()
  const card = main.getByRole('region', { name: 'Live call' })
  await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')
  return card
}

const heard = (text: string, final: boolean) => ({ text, input_type: 'transcription', final, timestamp: '' })

/** The EA listens on a call and captions the user's question as it forms. */
export async function eaListening(page: Page): Promise<void> {
  const card = await callEa(page)
  await botSays(page, 'user-input', heard('Did the checkout PR', false))
  await expect(card.locator('[data-kind="user"]')).toHaveText(/Did the checkout PR/)
}

/** The EA answers aloud after a tool call, its words captioned as it speaks. */
export async function eaSpeaking(page: Page): Promise<void> {
  const card = await callEa(page)
  await botSays(page, 'user-input', heard(QUESTION, true))
  await botSays(page, 'llm-function-call-in-progress', { function_name: 'list_prs', tool_call_id: 'p1' })
  await botSays(page, 'server-message', {
    type: 'ea-action',
    tool: 'list_prs',
    summary: '#482 checks pass, 2 threads open',
    ok: true,
  })
  await botSays(page, 'llm-function-call-stopped', { function_name: 'list_prs', tool_call_id: 'p1', cancelled: false })
  await botSays(page, 'bot-started-speaking')
  await botSays(page, 'bot-output', {
    text: ANSWER,
    segment_id: 1,
    will_be_spoken: true,
    spoken_progress: { accumulated_text: ANSWER, remaining_text: '' },
  })
  await expect(card.getByTestId('ea-call-status')).toHaveText('EA speaking')
  await expect(card.locator('[data-kind="bot"]')).toHaveText(/third timeout/)
}

/** Asleep on a live call over the agent list: the call sheet shows the wake phrase to say. */
export async function eaAsleep(page: Page): Promise<void> {
  const card = await callEa(page)
  await botSays(page, 'server-message', {
    type: 'ea-wake',
    enabled: true,
    awake: false,
    phrase: 'Hey Seti',
    local: true,
  })
  await expect(card.getByTestId('ea-call-status')).toHaveText('Asleep')
  await page.evaluate(() => {
    window.location.hash = '#agents'
  })
  await expect(page.getByRole('main').getByRole('region', { name: 'Needs you' })).toBeVisible()
  await page.getByRole('button', { name: 'EA call controls' }).tap()
  const sheet = page.getByRole('dialog').getByRole('region', { name: 'EA call' })
  await expect(sheet).toContainText('Say "Hey Seti" to wake it')
}
