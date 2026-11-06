import { randomUUID } from 'node:crypto'
import type { AuditPage, Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { fakeGhEnv, prNode, setFakeGh, type FakeComment } from './support/fake-gh-env.js'
import { apiData, expect, test } from './support/fixtures.js'

test.use({ serverEnv: fakeGhEnv() })

const MERGING = 'https://github.com/e2e/web/pull/5'
const STAYING = 'https://github.com/e2e/web/pull/6'
const VIEWER = 'e2e-user'
const MERGED_AT = '2026-10-07T11:00:00Z'

const comments: FakeComment[] = [
  { id: '101', login: 'alice', body: 'Please add a test for the redirect.', created_at: '2026-10-07T10:00:00Z' },
  { id: '102', login: VIEWER, body: 'Rebase on main first.', created_at: '2026-10-07T10:01:00Z' },
]

/** An idle agent that holds its updates, linked to both PRs, which Seti has polled once already. */
async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, input_mode, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', 'queue', ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  const baseline = JSON.stringify({ state: 'open', conflicting: false, ci: null, review_ids: [], comment_ids: [] })
  for (const url of [MERGING, STAYING]) {
    await db.run(
      `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, '2026-10-01T00:00:00Z', 'user')`,
      id,
      url,
    )
    await db.run(
      `INSERT INTO pr_watch (pr_url, snapshot, open, checked_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (pr_url) DO UPDATE SET snapshot = excluded.snapshot, open = 1, checked_at = excluded.checked_at`,
      url,
      baseline,
      ts,
    )
  }
  await db.close()
  return id
}

test('hands new PR comments to the agent as one update, and drops a PR with its merge comment', async ({
  page,
  request,
}) => {
  setFakeGh(VIEWER, { [MERGING]: prNode(MERGING, 'OPEN'), [STAYING]: prNode(STAYING, 'OPEN') })
  const id = await seedAgent('E2E PR comments')
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const merging = main.getByRole('group', { name: 'Pull request web#5' })
  const staying = main.getByRole('group', { name: 'Pull request web#6' })
  await expect(merging).toBeVisible()
  await expect(staying).toBeVisible()

  setFakeGh(VIEWER, { [MERGING]: prNode(MERGING, 'OPEN', comments), [STAYING]: prNode(STAYING, 'OPEN') })
  const cards = main.locator('[data-kind="input"]')
  const update = cards.filter({ hasText: '2 new comments on e2e/web#5' })
  await expect(update).toBeVisible()
  await expect(update.getByText('Please add a test for the redirect.')).toBeHidden()
  const toggle = update.getByRole('button', { name: '2 new comments on e2e/web#5' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(update).toContainText('alice commented')
  await expect(update).toContainText('Please add a test for the redirect.')
  await expect(update).toContainText(`${VIEWER} commented`)
  await expect(update).toContainText('Rebase on main first.')
  await expect(update.getByRole('link', { name: 'Open e2e/web#5 on GitHub' })).toHaveAttribute('href', MERGING)
  await expect(cards).toHaveCount(1)

  const closing: FakeComment = { id: '103', login: 'bob', body: 'Merging for the release.', created_at: MERGED_AT }
  const ended = prNode(MERGING, 'MERGED', [...comments, closing], MERGED_AT)
  setFakeGh(VIEWER, { [MERGING]: ended, [STAYING]: prNode(STAYING, 'OPEN') })
  const merged = cards.filter({ hasText: 'e2e/web#5 was merged' })
  await expect(merged).toBeVisible()
  await merged.getByRole('button', { name: 'e2e/web#5 was merged' }).click()
  await expect(merged).toContainText('bob: Merging for the release.')
  await expect(cards).toHaveCount(2)
  await expect(merging).toBeHidden()
  await expect(staying).toBeVisible()
  await expect(main.getByRole('group', { name: /^Pull request web#/ })).toHaveCount(1)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).pr_urls).toEqual([STAYING])

  const audited = async () =>
    (await apiData<AuditPage>(request, `/audit?kind=task.pr_unlinked&q=${id}&limit=5`)).events.map((e) => e.summary)
  await expect.poll(audited).toEqual(['Unlinked PR e2e/web#5 (it merged)'])
})
