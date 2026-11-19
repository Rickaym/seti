import { EA_HEADERS } from './support/env.js'
import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { customSenderChecksASample, linearReachesTheAgent } from './support/webhook-senders.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a Linear webhook from the picker reaches the subscribed agent and logs a forged delivery', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  await linearReachesTheAgent({ page, request, press: async (target) => target.click(), phone: false })
})

test('a custom sender is described and checked with a pasted request, before and after creating', async ({
  page,
  request,
}) => {
  await customSenderChecksASample({ page, request, press: async (target) => target.click(), phone: false })
})

test('the EA cannot set a secret, describe a sender or check a sample', async ({ request }) => {
  const sender = { signature: { scheme: 'hmac', header: 'X-Sig' } }
  const refused = [
    await request.post('/api/channels', { headers: EA_HEADERS, data: { name: 'x', preset: 'custom', sender } }),
    await request.post('/api/channels/sample', {
      headers: EA_HEADERS,
      data: { definition: sender, secret: 's', headers: '', body: '{}' },
    }),
  ]
  expect(refused.map((response) => response.status())).toEqual([403, 403])
})
