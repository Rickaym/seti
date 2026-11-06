import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { PrCheck, PrList, PullRequest, StartAgentInput } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const QUIET = 'e2e/quiet'
const RED = 'e2e/red'
const LOG = 'https://github.com/e2e/red/actions/runs/7/job/8'

const prUrl = (slug: string, number: number) => `https://github.com/${slug}/pull/${String(number)}`

function pr(slug: string, number: number, over: Partial<PullRequest> = {}): PullRequest {
  const repo = slug.split('/').at(-1) ?? slug
  return {
    key: `${repo}-${String(number)}`,
    repo_id: slug,
    repo_slug: slug,
    number,
    title: `${repo} change ${String(number)}`,
    url: prUrl(slug, number),
    draft: false,
    author: 'e2e',
    head_ref: `feat/${repo}-${String(number)}`,
    base_ref: 'main',
    head_oid: 'abc1234def',
    updated_at: `2026-10-03T0${String(number)}:00:00Z`,
    review_decision: null,
    mergeable: 'mergeable',
    labels: [],
    ci: 'success',
    checks: [],
    unresolved_threads: 0,
    preview: { state: 'none', url: null, commit: null, stale: false },
    preview_host: null,
    tasks: [],
    related: [],
    ...over,
  }
}

const check = (name: string, state: PrCheck['state'], detail: string, url: string | null): PrCheck => ({
  name,
  state,
  detail,
  url,
})

const FAILING = [
  check('lint', 'success', 'success', null),
  check('build', 'failure', 'failure', LOG),
  check('e2e', 'failure', 'timed_out', null),
]

const OPEN = [pr(RED, 5, { ci: 'failure', checks: FAILING }), ...[1, 2, 3, 4, 6, 7].map((n) => pr(QUIET, n))]

/** An idle agent with the given PRs linked, so no agent ever runs. */
async function seedAgent(title: string, urls: readonly string[]): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, title, paths.checkout, at)
  for (const url of urls) {
    await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, id, url, at)
  }
  await db.close()
  return id
}

async function mockStatuses(page: Page): Promise<void> {
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    const asked = new Set((route.request().postDataJSON() as { urls: string[] }).urls)
    await route.fulfill({ json: { data: OPEN.filter((item) => asked.has(item.url)), meta: {} } })
  })
}

async function interceptStart(page: Page): Promise<StartAgentInput[]> {
  const sent: StartAgentInput[] = []
  await page.route('**/api/tasks/start', async (route) => {
    sent.push(route.request().postDataJSON() as StartAgentInput)
    await route.fulfill({ json: { data: { id: 'e2e-intercepted' }, meta: {} } })
  })
  return sent
}

async function expectFixCiStart(page: Page, sent: readonly StartAgentInput[]): Promise<void> {
  const main = page.getByRole('main')
  await expect(page).toHaveURL(/#agents\/new$/)
  await expect(main.getByRole('button', { name: 'Drop Fix CI on #5 in e2e/red' })).toBeVisible()
  const message = main.getByLabel('Message')
  await expect(message).toHaveValue(/^Fix the failing CI on pull request #5 in e2e\/red: red change 5/)
  await expect(message).toHaveValue(/Failing checks on abc1234:\n- build: failed \(https:.+\)\n- e2e: timed out\n/)
  await message.press('Enter')
  await expect(page).toHaveURL(/#agents\/e2e-intercepted$/)
  expect(sent).toMatchObject([{ repo_ids: [RED], ref: 'feat/red-5', pr_urls: [prUrl(RED, 5)] }])
}

test('a failing chip shows how each check ended with its log, and Fix CI starts an agent on them', async ({ page }) => {
  await mockStatuses(page)
  const id = await seedAgent('E2E fix CI chip', [prUrl(RED, 5), prUrl(QUIET, 1)])
  const sent = await interceptStart(page)
  await page.goto('/#agents')
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('group', { name: 'Pull request quiet#1' })).toContainText('ci pass')
  await expect(main.getByRole('button', { name: 'Failing checks of quiet#1' })).toHaveCount(0)

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
  await expectFixCiStart(page, sent)
  await page.unroute('**/api/tasks/start')
  await page.request.delete(`/api/tasks/${id}`)
})

test('Fix CI starts from the failing row of the linked PR list', async ({ page }) => {
  await mockStatuses(page)
  const id = await seedAgent(
    'E2E fix CI list',
    OPEN.map((item) => item.url),
  )
  const sent = await interceptStart(page)
  await page.goto(`/#agents/${id}`)
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
  await row.getByRole('button', { name: 'Fix CI' }).click()
  await expect(list).toBeHidden()
  await expectFixCiStart(page, sent)
  await page.unroute('**/api/tasks/start')
  await page.request.delete(`/api/tasks/${id}`)
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
