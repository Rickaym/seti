import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import {
  expectNameArrivesLive,
  expectSendRequestAndRow,
  mentionReachesEa,
  startSlackPoster,
} from './support/slack-names.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a Slack send names its channel in the request and in the transcript', async ({ page, request }) => {
  await expectSendRequestAndRow(page, await startSlackPoster(request, true), false, true)
})

test('a Slack send to a channel Seti never saw named says the name is not known', async ({ page, request }) => {
  await expectSendRequestAndRow(page, await startSlackPoster(request, false), false, false)
})

test('a Slack name an agent learns shows on the waiting request and its row at once', async ({ page, request }) => {
  await expectNameArrivesLive(page, request, false)
})

test('a Slack mention reaches the EA with names in place of ids', async ({ request, baseURL }) => {
  const webhook = await mentionReachesEa(request, baseURL ?? '')
  expect((await request.delete(`/api/channels/${webhook}`)).ok()).toBe(true)
})
