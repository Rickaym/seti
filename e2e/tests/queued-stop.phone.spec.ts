import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { expectHandedOver, expectQueued, heldAgent, QUEUED, reply } from './support/queued-stop.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('Stop with a message queued hands it over on a phone without a stop notice', async ({ page, request }) => {
  const id = await heldAgent(page, 'Phone queued stop')
  await reply(page).fill(QUEUED)
  await page.getByRole('button', { name: 'Queue message' }).tap()
  await expectQueued(page)
  await page.getByTestId('agent-header').getByRole('button', { name: 'Stop', exact: true }).tap()
  await expectHandedOver(page)
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
