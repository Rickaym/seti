import { randomUUID } from 'node:crypto'
import type { PrList } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'
import { startAgent } from './support/many-prs.js'
import {
  agentCount,
  expectFixCiSent,
  linkPrs,
  LOG,
  mockStatuses,
  OPEN,
  pr,
  prUrl,
  QUIET,
  RED,
  watchStarts,
} from './support/pr-ci.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { FANOUT, SEEDS } from './support/subtasks.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

/** An idle agent with the given PRs linked, so no agent ever runs. */
async function seedAgent(title: string, urls: readonly string[]): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  await linkPrs(id, urls)
  return id
}

test('a failing chip shows how each check ended with its log, and Fix CI asks its own agent', async ({
  page,
  request,
}) => {
  await mockStatuses(page)
  const agent = await startAgent(request, 'E2E fix CI chip')
  await linkPrs(agent.id, [prUrl(RED, 5), prUrl(QUIET, 1)])
  const starts = watchStarts(page)
  await page.goto(`/#agents/${agent.id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('group', { name: 'Pull request quiet#1' })).toContainText('ci pass')
  await expect(main.getByRole('button', { name: 'Failing checks of quiet#1' })).toHaveCount(0)
  const before = await agentCount(request)

  await main.getByRole('button', { name: 'Failing checks of red#5' }).click()
  const checks = page.getByRole('dialog')
  const failing = checks.getByTestId('failing-check')
  await expect(failing).toHaveCount(2)
  await expect(failing.nth(0)).toContainText('build')
  await expect(failing.nth(0)).toContainText('failed')
  await expect(failing.nth(0).getByRole('link', { name: 'Open the build log' })).toHaveAttribute('href', LOG)
  await expect(failing.nth(1)).toContainText('e2e')
  await expect(failing.nth(1)).toContainText('timed out')
  await expect(failing.nth(1).getByRole('link')).toHaveCount(0)
  await checks.getByRole('button', { name: 'Fix CI' }).click()
  await expect(checks).toBeHidden()
  await expectFixCiSent(page, agent)
  expect(await agentCount(request)).toBe(before)
  expect(starts).toEqual([])
})

test('Fix CI on the failing row of the linked PR list asks the agent', async ({ page, request }) => {
  await mockStatuses(page)
  const agent = await startAgent(request, 'E2E fix CI list')
  await linkPrs(
    agent.id,
    OPEN.map((item) => item.url),
  )
  const starts = watchStarts(page)
  await page.goto(`/#agents/${agent.id}`)
  await page
    .getByRole('main')
    .getByRole('button', { name: /^\+\d+ more/ })
    .click()
  const list = page.getByRole('dialog', { name: /^Linked PRs/ })
  const row = list.getByRole('listitem', { name: 'Pull request red#5' })
  await expect(list.getByRole('region', { name: 'Needs a fix' })).toContainText('red change 5')
  await expect(row.getByTestId('failing-check')).toHaveCount(2)
  await expect(row.getByRole('link', { name: 'Open the build log' })).toHaveAttribute('href', LOG)
  await expect(list.getByRole('listitem', { name: 'Pull request quiet#1' }).getByTestId('failing-checks')).toHaveCount(
    0,
  )
  const before = await agentCount(request)
  await row.getByRole('button', { name: 'Fix CI' }).click()
  await expect(list).toBeHidden()
  await expectFixCiSent(page, agent)
  expect(await agentCount(request)).toBe(before)
  expect(starts).toEqual([])
})

test("Fix CI on a subagent's PR asks the parent agent and opens it", async ({ page, request }) => {
  await mockStatuses(page)
  const agent = await startAgent(request, 'E2E fix CI subagent')
  const db = openSeedDb()
  for (const [index, [kind, payload]] of SEEDS.fanOut().entries()) {
    await db.message(agent.id, kind, JSON.stringify(payload), new Date(Date.now() + index).toISOString())
  }
  await db.close()
  await linkPrs(agent.id, [prUrl(RED, 5)], FANOUT.agent.id)
  const starts = watchStarts(page)
  await page.goto(`/#agents/${agent.id}/sub/${FANOUT.agent.id}`)
  const prs = page.getByRole('main').getByTestId('subtask-prs')
  const before = await agentCount(request)
  await prs.getByRole('button', { name: 'Failing checks of red#5' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Fix CI' }).click()
  await expectFixCiSent(page, agent)
  expect(await agentCount(request)).toBe(before)
  expect(starts).toEqual([])
})

test('chips, list rows and palette rows open the PR on GitHub in a new tab', async ({ page }) => {
  await mockStatuses(page)
  const id = await seedAgent(
    'E2E PRs on GitHub',
    OPEN.map((item) => item.url),
  )
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const chip = main.getByRole('link', { name: 'red#5', exact: true })
  await expect(chip).toHaveAttribute('href', prUrl(RED, 5))
  await expect(chip).toHaveAttribute('target', '_blank')

  await main.getByRole('button', { name: /^\+\d+ more/ }).click()
  const row = page
    .getByRole('dialog', { name: /^Linked PRs/ })
    .getByRole('listitem', { name: 'Pull request quiet#7' })
    .getByRole('link', { name: /quiet change 7/ })
  await expect(row).toHaveAttribute('href', prUrl(QUIET, 7))
  await expect(row).toHaveAttribute('target', '_blank')
  await page.keyboard.press('Escape')

  const list: PrList = {
    viewer: 'e2e',
    scope: 'all',
    repos: [{ repo_id: RED, slug: RED, error: null, previews: false, prs: [OPEN[0] ?? pr(RED, 5)] }],
    previews_on: true,
  }
  await page.route(/\/api\/prs\?scope=all$/, async (route) => route.fulfill({ json: { data: list, meta: {} } }))
  await page.evaluate(() => {
    const opened: unknown[][] = []
    Object.assign(window, { opened })
    window.open = (...args: unknown[]) => {
      opened.push(args)
      return null
    }
  })
  await page.keyboard.press('Control+k')
  await page.keyboard.type('red change 5')
  await expect(
    page.getByRole('dialog', { name: 'Search Seti' }).getByRole('option', { name: /red change 5/ }),
  ).toBeVisible()
  await page.keyboard.press('Enter')
  const opened = async () => page.evaluate(() => (window as unknown as { opened: unknown[][] }).opened)
  await expect.poll(opened).toEqual([[prUrl(RED, 5), '_blank', 'noopener,noreferrer']])
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
  await page.request.delete(`/api/tasks/${id}`)
})
