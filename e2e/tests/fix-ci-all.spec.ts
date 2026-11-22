import { agentWithTwoFailing, BOTH, mockFailing, promptsOf } from './support/fix-ci.js'
import { expect, test } from './support/fixtures.js'
import { startAgent } from './support/many-prs.js'
import { agentCount, linkPrs, ownMessages, prUrl, QUIET, watchStarts } from './support/pr-ci.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('Fix CI in the agent header sends one short message naming both failing PRs', async ({ page, request }) => {
  await mockFailing(page)
  const agent = await agentWithTwoFailing(request, 'E2E fix CI all')
  const starts = watchStarts(page)
  await page.goto(`/#agents/${agent.id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('button', { name: 'Failing checks of red#5' })).toBeVisible()
  const before = await agentCount(request)

  const fix = main.getByTestId('fix-ci-all')
  await expect(fix).toHaveText('Fix CI')
  await fix.hover()
  await expect(page.getByRole('tooltip')).toContainText('Ask the agent to fix failing CI on all 2 PRs')
  await fix.click()
  await expect(page.getByText(`Asked ${agent.title} to fix CI on 2 PRs`)).toBeVisible()
  await expect(ownMessages(page, BOTH)).toHaveCount(1)
  await expect.poll(async () => promptsOf(request, agent.id)).toEqual([BOTH])
  expect(await agentCount(request)).toBe(before)
  expect(starts).toEqual([])
})

test('the header has no Fix CI while no linked PR fails', async ({ page, request }) => {
  await mockFailing(page)
  const agent = await startAgent(request, 'E2E fix CI none')
  await linkPrs(agent.id, [prUrl(QUIET, 1)])
  await page.goto(`/#agents/${agent.id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('group', { name: 'Pull request quiet#1' })).toContainText('ci pass')
  await expect(main.getByRole('button', { name: 'Fix CI', exact: true })).toHaveCount(0)
})
