import { randomUUID } from 'node:crypto'
import { test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { expectRepliesRow, seedFollower, stopFollowedThread } from './support/slack-settings.js'

test('a followed Slack thread stops with a tap on a phone', async ({ page }) => {
  const id = await seedFollower(`Phone follower ${randomUUID().slice(0, 8)}`, 'C0E2ESTOP02')
  await stopFollowedThread(page, id, true)
  await expectFitsPhone(page, 'the Team tab after stopping a thread')
})

test('the Slack webhook reply switches fit a phone', async ({ page, request, baseURL }) => {
  const name = `Phone Slack ${randomUUID().slice(0, 8)}`
  const webhook = await expectRepliesRow(page, request, { baseURL: baseURL ?? '', name, tap: true })
  await expectFitsPhone(page, 'Slack webhook reply switches')
  await request.delete(`/api/channels/${webhook}`)
})
