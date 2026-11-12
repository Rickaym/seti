import { expect, test } from './support/fixtures.js'
import { startAgent } from './support/many-prs.js'
import { openAgentPrs } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { agentCount, expectFixCiSent, linkPrs, LOG, mockStatuses, OPEN, watchStarts } from './support/pr-ci.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('Fix CI in the phone sheet of linked PRs asks the agent, without a new one', async ({ page, request }) => {
  await mockStatuses(page)
  const agent = await startAgent(request, 'Phone fix CI')
  await linkPrs(
    agent.id,
    OPEN.map((item) => item.url),
  )
  const starts = watchStarts(page)
  await page.goto(`/#agents/${agent.id}`)
  const before = await agentCount(request)

  const sheet = await openAgentPrs(page)
  const row = sheet.getByRole('listitem', { name: 'Pull request red#5' })
  await expect(row.getByTestId('failing-check')).toHaveCount(2)
  await expect(row.getByRole('link', { name: 'Open the build log' })).toHaveAttribute('href', LOG)
  await expectFitsPhone(page, 'failing checks in the linked PRs sheet')
  await row.getByRole('button', { name: 'Fix CI' }).tap()
  await expect(sheet).toBeHidden()
  await expectFixCiSent(page, agent)
  await expectFitsPhone(page, 'agent after Fix CI')
  expect(await agentCount(request)).toBe(before)
  expect(starts).toEqual([])
})
