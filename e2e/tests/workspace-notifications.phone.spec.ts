import { expect, test } from './support/fixtures.js'
import { homeScreenApp } from './support/ios.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { mockPushManager, PUSH_ENV, startPushService, type PushService } from './support/push.js'
import { clearScenario, eaKeepsToTheOpenWorkspace, keepsToTheOpenWorkspace } from './support/workspace-notify.js'

test.use({ serverEnv: { ...FAKE_CLAUDE_ENV, ...PUSH_ENV }, failureToasts: true })

let service: PushService
let agents: string[] = []

test.beforeEach(async ({ page }) => {
  service = await startPushService()
  await mockPushManager(page, service)
  await homeScreenApp(page)
})

test.afterEach(async ({ request }) => {
  await clearScenario(request, agents)
  agents = []
  await service.close()
})

test('a phone hears only about its open workspace until the setting is off', async ({ page, request }) => {
  test.setTimeout(120_000)
  agents = await keepsToTheOpenWorkspace(page, request, service)
  const toggle = page.getByRole('main').getByRole('button', { name: 'Workspace only', exact: true })
  await expect(toggle).toBeInViewport()
  expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(32)
  await expectFitsPhone(page, 'notification settings with the workspace toggle')
})

test("on a phone, the EA's item about an agent follows the open workspace too", async ({ page, request }) => {
  test.setTimeout(120_000)
  agents = await eaKeepsToTheOpenWorkspace(page, request)
  await expectFitsPhone(page, 'an EA toast about an agent in another workspace')
})
