import { test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { expectNamedRequestAndRow, startSlackPoster } from './support/slack-names.js'
import { shot } from './support/thread-replies.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a Slack send names its channel on a phone', async ({ page, request }) => {
  const id = await startSlackPoster(request)
  await expectNamedRequestAndRow(page, id, true)
  await expectFitsPhone(page, 'a named Slack send in the transcript')
  await shot(page, 'slack-names-phone')
})
