import { randomUUID } from 'node:crypto'
import { test } from './support/fixtures.js'
import { expectMessageEventsLine, seedFollower, stopFollowedThread } from './support/slack-settings.js'
import { shot } from './support/thread-replies.js'

test('the Team tab lists a followed Slack thread by name and stops it', async ({ page }) => {
  const id = await seedFollower(`E2E follower ${randomUUID().slice(0, 8)}`, 'C0E2ESTOP01')
  await stopFollowedThread(page, id, false)
})

test('a Slack webhook shows its reply switches and whether message events arrive', async ({
  page,
  request,
  baseURL,
}) => {
  const name = `E2E Slack ${randomUUID().slice(0, 8)}`
  const webhook = await expectMessageEventsLine(page, request, baseURL ?? '', name)
  await shot(page, 'webhook-replies-desktop')
  await request.delete(`/api/channels/${webhook}`)
})
