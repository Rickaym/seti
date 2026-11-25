import { randomUUID } from 'node:crypto'
import { test } from './support/fixtures.js'
import { expectRepliesRow, seedFollower, stopFollowedThread } from './support/slack-settings.js'

test('the Team tab lists a followed Slack thread by name and stops it', async ({ page }) => {
  const id = await seedFollower(`E2E follower ${randomUUID().slice(0, 8)}`, 'C0E2ESTOP01')
  await stopFollowedThread(page, id, false)
})

test('a Slack webhook shows its reply switches off, then on with the message events hint', async ({
  page,
  request,
  baseURL,
}) => {
  const name = `E2E Slack ${randomUUID().slice(0, 8)}`
  const webhook = await expectRepliesRow(page, request, { baseURL: baseURL ?? '', name, tap: false })
  await request.delete(`/api/channels/${webhook}`)
})
