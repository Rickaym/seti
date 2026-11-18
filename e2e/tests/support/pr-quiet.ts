import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { prNode, setFakeGh, type FakeComment } from './fake-gh-env.js'
import { expect } from './fixtures.js'

const QUIET_PR = 'https://github.com/e2e/web/pull/5'
const VIEWER = 'e2e-user'
const POSTED_AT = '2026-10-07T10:00:00Z'

/** The agent's own comment, which its call's output links, and one the user wrote as that login. */
const comments: FakeComment[] = [
  { id: '201', login: VIEWER, body: 'Addressed in the last commit.', created_at: '2026-10-07T10:00:01Z' },
  { id: '202', login: VIEWER, body: 'Rebase on main first.', created_at: '2026-10-07T10:05:00Z' },
]

const call = {
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_comment',
        name: 'Bash',
        input: { command: 'gh pr comment 5 --body "Addressed in the last commit."' },
      },
    ],
  },
}

const result = {
  type: 'user',
  parent_tool_use_id: null,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_comment', content: `${QUIET_PR}#issuecomment-201` }],
  },
}

/** An idle agent that holds its updates and commented on its linked PR, which Seti polled once. */
export async function seedCommenter(title: string): Promise<string> {
  setFakeGh(VIEWER, { [QUIET_PR]: prNode(QUIET_PR, 'OPEN') })
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
  await db.run(
    `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, '2026-10-01T00:00:00Z', 'user')`,
    id,
    QUIET_PR,
  )
  const baseline = JSON.stringify({ state: 'open', conflicting: false, ci: null, review_ids: [], comment_ids: [] })
  await db.run(
    `INSERT INTO pr_watch (pr_url, snapshot, open, checked_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (pr_url) DO UPDATE SET snapshot = excluded.snapshot, open = 1, checked_at = excluded.checked_at`,
    QUIET_PR,
    baseline,
    ts,
  )
  await db.message(id, 'sdk', JSON.stringify(call), POSTED_AT)
  await db.message(id, 'sdk', JSON.stringify(result), '2026-10-07T10:00:02Z')
  await db.close()
  return id
}

/**
 * Both comments reach GitHub. The agent's own is only recorded, the user's waits for the agent,
 * and only that one counts as waiting.
 */
export async function expectOwnCommentQuiet(page: Page): Promise<void> {
  setFakeGh(VIEWER, { [QUIET_PR]: prNode(QUIET_PR, 'OPEN', comments) })
  const main = page.getByRole('main')
  const cards = main.locator('[data-kind="input"]')
  await expect(cards).toHaveCount(2)
  const sent = cards.filter({ hasNot: page.locator('[data-quiet]') })
  await expect(sent).toHaveCount(1)
  await expect(sent).toContainText(`${VIEWER} commented on e2e/web#5`)
  await expect(sent).toContainText('queued')
  await sent.getByRole('button', { name: `${VIEWER} commented on e2e/web#5` }).click()
  await expect(sent).toContainText('Rebase on main first.')

  const own = cards.filter({ has: page.locator('[data-quiet="own_action"]') })
  await expect(own).toHaveCount(1)
  await expect(own).toContainText('not sent: own action')
  await expect(own).not.toContainText('queued')
  await own.getByRole('button', { name: `${VIEWER} commented on e2e/web#5` }).click()
  await expect(own).toContainText('Addressed in the last commit.')
  await expect(main.getByTestId('queued-inputs')).toHaveText(/^1 queued/)
}
