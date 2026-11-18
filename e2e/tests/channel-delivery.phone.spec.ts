import { deliveryFollowsTheChoice } from './support/channel-delivery.js'
import { test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('each delivery choice works on a phone and decides when the agent gets the update', async ({ page, request }) => {
  test.setTimeout(180_000)
  await deliveryFollowsTheChoice({ page, request, press: async (target) => target.tap(), phone: true })
})
