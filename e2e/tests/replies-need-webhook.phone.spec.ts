import { randomUUID } from 'node:crypto'
import { test } from './support/fixtures.js'
import { expectRepliesNeedWebhook } from './support/replies-reach.js'

test('the replies need a Slack webhook line fits a phone', async ({ page, request }) => {
  const name = `Phone Slack poller ${randomUUID().slice(0, 8)}`
  await expectRepliesNeedWebhook(page, request, { name, channel: 'C0E2EREACH2', tap: true })
})
