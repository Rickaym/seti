import { test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { expectNameArrivesLive, expectSendRequestAndRow, startSlackPoster } from './support/slack-names.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

for (const named of [true, false]) {
  test(`a Slack send ${named ? 'names its channel' : 'says the name is not known'} on a phone`, async ({
    page,
    request,
  }) => {
    await expectSendRequestAndRow(page, await startSlackPoster(request, named), true, named)
    await expectFitsPhone(page, 'a Slack send in the transcript')
  })
}

test('a Slack name an agent learns shows on the waiting request at once on a phone', async ({ page, request }) => {
  await expectNameArrivesLive(page, request, true)
  await expectFitsPhone(page, 'a Slack send named while it waited')
})
