import { randomUUID } from 'node:crypto'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import {
  danaReplies,
  expectThreadReply,
  seedThreadAgent,
  shot,
  slackWebhookWithReplies,
} from './support/thread-replies.js'

test('a Slack thread reply fits the phone transcript', async ({ page, request, baseURL }) => {
  const tag = randomUUID().slice(0, 8)
  const channel = 'C0E2EPHON1'
  const id = await seedThreadAgent(`Phone Slack thread ${tag}`, channel)
  const { channel: webhook } = await slackWebhookWithReplies(request, `Phone Slack ${tag}`)
  try {
    await page.goto(`/#agents/${id}`)
    await expect(page.getByRole('main').getByRole('heading', { name: `Phone Slack thread ${tag}` })).toBeVisible()
    await danaReplies(baseURL ?? '', webhook.path, channel, 'Could you also check the staging deploy before Friday?')
    await expectThreadReply(page, channel)
    await expectFitsPhone(page, 'a Slack thread reply in the transcript')
    await shot(page, 'thread-reply-phone')
  } finally {
    await request.delete(`/api/channels/${webhook.id}`)
  }
})
