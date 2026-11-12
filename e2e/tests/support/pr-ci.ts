import type { APIRequestContext, Page } from '@playwright/test'
import type { PrCheck, PullRequest, TaskListEntry } from '@seti/shared'
import { openSeedDb } from './db.js'
import { apiData, expect } from './fixtures.js'

export const QUIET = 'e2e/quiet'
export const RED = 'e2e/red'
export const LOG = 'https://github.com/e2e/red/actions/runs/7/job/8'

export const prUrl = (slug: string, number: number) => `https://github.com/${slug}/pull/${String(number)}`

export function pr(slug: string, number: number, over: Partial<PullRequest> = {}): PullRequest {
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

/** One PR failing CI on two checks, then six passing ones. */
export const OPEN = [pr(RED, 5, { ci: 'failure', checks: FAILING }), ...[1, 2, 3, 4, 6, 7].map((n) => pr(QUIET, n))]

/** Answers the batched status lookup with the fixture's PRs, as GitHub would. */
export async function mockStatuses(page: Page): Promise<void> {
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    const asked = new Set((route.request().postDataJSON() as { urls: string[] }).urls)
    await route.fulfill({ json: { data: OPEN.filter((item) => asked.has(item.url)), meta: {} } })
  })
}

/** Links the PRs to the task, or to one of its subagents when `toolUseId` is given. */
export async function linkPrs(taskId: string, urls: readonly string[], toolUseId?: string): Promise<void> {
  const db = openSeedDb()
  const at = new Date().toISOString()
  for (const url of urls) {
    await db.run(
      `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user') ON CONFLICT DO NOTHING`,
      taskId,
      url,
      at,
    )
    if (toolUseId !== undefined) {
      await db.run(
        `INSERT INTO subtask_pr (task_id, pr_url, tool_use_id, linked_at, source) VALUES (?, ?, ?, ?, 'user')`,
        taskId,
        url,
        toolUseId,
        at,
      )
    }
  }
  await db.close()
}

export const agentCount = async (request: APIRequestContext) =>
  (await apiData<TaskListEntry[]>(request, '/tasks')).length

/** Records each request that would start a new agent. */
export function watchStarts(page: Page): string[] {
  const starts: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && (path === '/api/tasks' || path === '/api/tasks/start')) {
      starts.push(path)
    }
  })
  return starts
}

/** The Fix CI message for red#5 sits in the agent's own transcript, and the agent is open. */
export async function expectFixCiSent(page: Page, agent: { id: string; title: string }): Promise<void> {
  await expect(page.getByText(`Asked ${agent.title} to fix CI on #5`)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`#agents/${agent.id}$`))
  const sent = page
    .getByRole('region', { name: 'Transcript' })
    .locator('[data-own-message]')
    .filter({ hasText: 'CI is failing on your pull request #5 in e2e/red: red change 5' })
  await expect(sent).toHaveCount(1)
  await expect(sent).toContainText(prUrl(RED, 5))
  await expect(sent).toContainText('Commit abc1234 on feat/red-5')
  await expect(sent).toContainText(`- build: failed (${LOG})`)
  await expect(sent).toContainText('- e2e: timed out')
  await expect(sent).toContainText('push to the PR branch feat/red-5')
  await expect(sent).not.toContainText('worktree')
}
