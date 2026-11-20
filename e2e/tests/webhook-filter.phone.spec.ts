import { test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { filterDropsOneEventType } from './support/webhook-filter.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test("a webhook's filter is written, tested and read on a phone", async ({ page, request, baseURL }) => {
  await filterDropsOneEventType({ page, request, baseURL: baseURL ?? '', press: async (t) => t.tap(), phone: true })
})
