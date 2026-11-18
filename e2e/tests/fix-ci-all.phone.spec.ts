import {
  ACROSS,
  agentWithTwoFailing,
  BOTH,
  expectNudgeConfirm,
  mockFailing,
  promptsOf,
  twoAgentsToNudge,
} from './support/fix-ci.js'
import { expect, test } from './support/fixtures.js'
import { openAgentPrs } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { ownMessages } from './support/pr-ci.js'
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
  await expect(page.getByText(`Asked ${agent.title} to fix CI on 2 PRs`)).toBeVisible()
  await expect(ownMessages(page, BOTH)).toHaveCount(1)
  await expect.poll(async () => promptsOf(request, agent.id)).toEqual([BOTH])
  await expectFitsPhone(page, 'agent after Fix CI for all its PRs')
})

test('Fix CI in the phone Agents list nudges two agents after a confirm', async ({ page, request }) => {
  const agents = await twoAgentsToNudge(page, request, 'Phone nudge')
  await page.goto('/#agents')
  const fix = page.getByRole('button', { name: 'Fix CI' })
  await expect(fix).toContainText('3')
  await expectFitsPhone(page, 'Agents list with Fix CI')
  await fix.tap()
  await expectNudgeConfirm(page, agents)
  await expectFitsPhone(page, 'Fix CI confirm')
  await page.getByRole('dialog', { name: 'Fix CI' }).getByRole('button', { name: 'Nudge' }).tap()
  await expect(page.getByText('Asked 2 agents about 3 PRs to fix CI')).toBeVisible()
  await expect.poll(async () => promptsOf(request, agents.first.id)).toEqual([BOTH])
  await expect.poll(async () => promptsOf(request, agents.second.id)).toEqual([ACROSS])
})
