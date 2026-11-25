import { randomUUID } from 'node:crypto'
import { expect, test } from './support/fixtures.js'
import {
  danaReplies,
  expectThreadReply,
  seedThreadAgent,
  shot,
  slackWebhookWithReplies,
} from './support/thread-replies.js'

test('a reply in a Slack thread the agent started reaches it as a quiet transcript line', async ({
  page,
  request,
  baseURL,
}) => {
  const tag = randomUUID().slice(0, 8)
  const channel = 'C0E2EDESK1'
  const id = await seedThreadAgent(`E2E Slack thread ${tag}`, channel)
  const { channel: webhook } = await slackWebhookWithReplies(request, `E2E Slack ${tag}`)
  try {
    await page.goto(`/#agents/${id}`)
    await expect(page.getByRole('main').getByRole('heading', { name: `E2E Slack thread ${tag}` })).toBeVisible()
    await danaReplies(baseURL ?? '', webhook.path, channel, 'Could you also check the staging deploy before Friday?')
    await expectThreadReply(page, channel)
    await shot(page, 'thread-reply')
  } finally {
    await request.delete(`/api/channels/${webhook.id}`)
  }
})
