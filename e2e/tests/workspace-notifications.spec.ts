import { test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { mockPushManager, PUSH_ENV, startPushService, type PushService } from './support/push.js'
import { clearScenario, keepsToTheOpenWorkspace } from './support/workspace-notify.js'

test.use({ serverEnv: { ...FAKE_CLAUDE_ENV, ...PUSH_ENV }, failureToasts: true })

let service: PushService
let agents: string[] = []

test.beforeEach(async ({ page }) => {
  service = await startPushService()
  await mockPushManager(page, service)
})

test.afterEach(async ({ request }) => {
  await clearScenario(request, agents)
  agents = []
  await service.close()
})

test('a device hears only about its open workspace until the setting is off', async ({ page, request }) => {
  test.setTimeout(120_000)
  agents = await keepsToTheOpenWorkspace(page, request, service)
})
