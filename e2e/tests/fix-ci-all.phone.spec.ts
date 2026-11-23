import { agentWithTwoFailing, BOTH, mockFailing, promptsOf } from './support/fix-ci.js'
import { expect, test } from './support/fixtures.js'
import { openAgentPrs } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { expectNoFixCiToast, ownMessages } from './support/pr-ci.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('Fix CI at the top of the phone PR sheet sends one message naming both failing PRs', async ({ page, request }) => {
  await mockFailing(page)
  const agent = await agentWithTwoFailing(request, 'Phone fix CI all')
  await page.goto(`/#agents/${agent.id}`)
  const sheet = await openAgentPrs(page)
  await expect(sheet).toContainText('CI is failing on 2 PRs')
  await expectFitsPhone(page, 'Fix CI at the top of the linked PRs sheet')
  await sheet.getByTestId('fix-ci-all').tap()
  await expect(sheet).toBeHidden()
  await expect(ownMessages(page, BOTH)).toHaveCount(1)
  await expectNoFixCiToast(page)
  await expect.poll(async () => promptsOf(request, agent.id)).toEqual([BOTH])
  await expectFitsPhone(page, 'agent after Fix CI for all its PRs')
})
