import { test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { filterDropsOneEventType } from './support/webhook-filter.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test("a webhook's filter drops one event type before the subscribed agent, and Test agrees", async ({
  page,
  request,
  baseURL,
}) => {
  await filterDropsOneEventType({ page, request, baseURL: baseURL ?? '', press: async (t) => t.click(), phone: false })
})
