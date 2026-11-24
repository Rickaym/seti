import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { expectNamedRequestAndRow, mentionReachesEa, startSlackPoster } from './support/slack-names.js'
import { shot } from './support/thread-replies.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a Slack send names its channel in the request and in the transcript', async ({ page, request }) => {
  const id = await startSlackPoster(request)
  await expectNamedRequestAndRow(page, id, false)
  await shot(page, 'slack-names-desktop')
})

test('a Slack mention reaches the EA with names in place of ids', async ({ request, baseURL }) => {
  const webhook = await mentionReachesEa(request, baseURL ?? '')
  expect((await request.delete(`/api/channels/${webhook}`)).ok()).toBe(true)
})
