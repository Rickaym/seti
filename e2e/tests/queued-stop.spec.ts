import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { expectHandedOver, expectQueued, expectStopped, heldAgent, QUEUED, reply } from './support/queued-stop.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('Esc with a message queued hands it over without a stop notice for the cut turn', async ({ page, request }) => {
  const id = await heldAgent(page, 'Queued stop')
  await reply(page).fill(QUEUED)
  await reply(page).press('Enter')
  await expectQueued(page)
  await page.keyboard.press('Escape')
  await expectHandedOver(page)
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})

test('Esc with nothing queued still marks the turn interrupted', async ({ page, request }) => {
  const id = await heldAgent(page, 'Plain stop')
  await page.keyboard.press('Escape')
  await expectStopped(page)
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
