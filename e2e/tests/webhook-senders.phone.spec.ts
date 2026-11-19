import { test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { customSenderChecksASample, linearReachesTheAgent } from './support/webhook-senders.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a Linear webhook is made on a phone and reaches the subscribed agent', async ({ page, request }) => {
  test.setTimeout(120_000)
  await linearReachesTheAgent({ page, request, press: async (target) => target.tap(), phone: true })
})

test('a custom sender is described and checked with a pasted request on a phone', async ({ page, request }) => {
  await customSenderChecksASample({ page, request, press: async (target) => target.tap(), phone: true })
})
