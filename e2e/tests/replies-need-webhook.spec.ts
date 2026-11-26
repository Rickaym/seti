import { randomUUID } from 'node:crypto'
import { test } from './support/fixtures.js'
import { expectRepliesNeedWebhook } from './support/replies-reach.js'

test('a Slack poller and the Team tab say replies need a Slack webhook until one reads them', async ({
  page,
  request,
}) => {
  const name = `E2E Slack poller ${randomUUID().slice(0, 8)}`
  await expectRepliesNeedWebhook(page, request, { name, channel: 'C0E2EREACH1', tap: false })
})
