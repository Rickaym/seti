import { randomUUID } from 'node:crypto'
import type { PrInput, Task } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'

const PR = 'https://github.com/e2e/web/pull/12'
/** AUTO_TURN_BURST.turns on the server: this many automatic turns in an hour pause waking. */
const AUTO_TURNS_PER_HOUR = 20

const failing: PrInput = {
  source: 'pr',
  kind: 'ci_failed',
  subject: 'e2e/web#12',
  title: 'CI failed on e2e/web#12',
  body: 'Failing checks on abc1234:\n- unit (failure)',
  url: PR,
}

const review: PrInput = {
  source: 'pr',
  kind: 'review',
  subject: 'e2e/web#12',
  title: 'alice requested changes on e2e/web#12',
  body: [
    '<details> <summary>About Codex in GitHub</summary> <br/>',
    '',
    'Reviews are triggered when you open a pull request.',
    '',
    '</details>',
    '',
    '<sub><sub>P2 Badge</sub></sub> Please add a test.',
    '',
    '<img src="x" onerror="window.__pwned = true"><script>window.__pwned = true</script>',
  ].join('\n'),
  url: `${PR}#pullrequestreview-1`,
}

/** An idle task holding PR updates, with one update the agent already read; no agent runs. */
async function seedTask(title: string): Promise<string> {
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
  await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, id, PR, ts)
  await db.message(id, 'input', JSON.stringify({ ...failing, title: 'CI failed on e2e/web#12 earlier' }), ts)
  await db.message(id, 'prompt', JSON.stringify({ text: '', auto: true, inputs: 1 }), ts)
  await db.message(id, 'input', JSON.stringify(failing), ts)
  await db.message(id, 'input', JSON.stringify(review), ts)
  await db.close()
  return id
}

test('shows PR updates in the transcript, marks the unread ones and switches the task mode', async ({
  page,
  request,
}) => {
  const id = await seedTask('E2E PR updates')
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'E2E PR updates' })).toBeVisible()

  const cards = main.locator('[data-kind="input"]')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).not.toContainText('queued')
  await expect(main.getByText('Seti started a turn to hand the agent 1 update')).toBeVisible()
  await expect(cards.nth(1)).toContainText('CI failed on e2e/web#12')
  await expect(cards.nth(1).getByText('unit (failure)')).toBeHidden()
  await cards.nth(1).getByRole('button', { name: 'CI failed on e2e/web#12' }).press('Enter')
  await expect(cards.nth(1).getByText('unit (failure)')).toBeVisible()
  await expect(cards.nth(1)).toContainText('queued')
  await expect(cards.nth(2)).toContainText('alice requested changes on e2e/web#12')
  await expect(cards.nth(2).getByRole('link', { name: 'Open e2e/web#12 on GitHub' })).toHaveAttribute(
    'href',
    `${PR}#pullrequestreview-1`,
  )

  const html = cards.nth(2)
  await html.getByRole('button', { name: 'alice requested changes on e2e/web#12' }).click()
  const about = html.locator('details')
  await expect(about.locator('summary')).toHaveText('About Codex in GitHub')
  await expect(about.getByText('Reviews are triggered')).toBeHidden()
  await about.locator('summary').click()
  await expect(about.getByText('Reviews are triggered')).toBeVisible()
  await expect(html.locator('sub sub')).toHaveText('P2 Badge')
  await expect(html.locator('script')).toHaveCount(0)
  await expect(html.locator('img')).not.toHaveAttribute('onerror')
  expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined()

  const waiting = main.getByTestId('queued-inputs')
  await expect(waiting).toHaveText(/^2 queued/)
  await expect(waiting).toHaveAttribute('data-waiting', 'message')
  await waiting.getByRole('button', { name: '2 queued' }).click()
  await expect(page.getByRole('dialog')).toHaveText('2 updates wait for the agent. They go with your next message.')
  await page.keyboard.press('Escape')
  await expect(waiting.getByRole('button', { name: 'Hand over' })).toBeEnabled()

  await openAgentSettings(page, 'Team')
  const mode = page.getByRole('combobox', { name: 'Updates' })
  await expect(mode).toHaveText('Wait for my message')
  await mode.click()
  await page.getByRole('option', { name: 'Off' }).click()
  await expect(mode).toHaveText('Off')
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).input_mode).toBe('off')
})

test('dismisses waiting updates, asking first only when several wait', async ({ page }) => {
  const id = await seedTask('E2E dismiss updates')
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const waiting = main.getByTestId('queued-inputs')
  await expect(waiting).toHaveText(/^2 queued/)

  await waiting.getByRole('button', { name: 'Dismiss' }).click()
  const confirm = page.getByRole('dialog', { name: 'Dismiss updates' })
  await expect(confirm).toContainText('Dismiss 2 waiting updates (2 PR updates)?')
  await confirm.getByRole('button', { name: 'Dismiss' }).click()
  await expect(waiting).toBeHidden()
  const cards = main.locator('[data-kind="input"]')
  await expect(cards.nth(0)).not.toContainText('dismissed')
  await expect(cards.nth(1)).toContainText('dismissed')
  await expect(cards.nth(2)).toContainText('dismissed')
  await expect(main.locator('[data-dismissed]')).toHaveCount(2)

  const db = openSeedDb()
  const later = { ...failing, title: 'CI failed again on e2e/web#12' }
  await db.message(id, 'input', JSON.stringify(later), new Date().toISOString())
  await db.close()
  await page.reload()
  await expect(waiting).toHaveText(/^1 queued/)
  await expect(cards.nth(3)).toContainText('queued')

  await waiting.getByRole('button', { name: 'Dismiss' }).click()
  await expect(waiting).toBeHidden()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(cards.nth(3)).toContainText('dismissed')
  await expect(main.locator('[data-dismissed]')).toHaveCount(3)
})

/** A wake task with a burst of automatic turns in the last hour and one update still waiting. */
async function seedBurstTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const start = Date.now() - 30 * 60_000
  const ts = new Date(start).toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, input_mode, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', 'wake', ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  for (let turn = 0; turn < AUTO_TURNS_PER_HOUR; turn += 1) {
    const at = new Date(start + turn * 60_000).toISOString()
    await db.message(id, 'input', JSON.stringify(failing), at)
    await db.message(id, 'prompt', JSON.stringify({ text: '', auto: true, inputs: 1 }), at)
  }
  await db.message(id, 'input', JSON.stringify(review), new Date().toISOString())
  await db.close()
  return id
}

test('says when a burst of automatic turns paused a wake task and offers to hand over now', async ({ page }) => {
  const id = await seedBurstTask('E2E burst pause')
  await page.goto(`/#agents/${id}`)
  const waiting = page.getByRole('main').getByTestId('queued-inputs')
  await expect(waiting).toHaveText(/^1 queued until \d/)
  await expect(waiting).toHaveAttribute('data-waiting', 'paused')
  await waiting.getByRole('button', { name: /^1 queued/ }).click()
  await expect(page.getByRole('dialog')).toHaveText(
    /^1 update waits for the agent\. Seti paused after a burst of automatic turns and hands them over at \d/,
  )
  await page.keyboard.press('Escape')
  await expect(waiting.getByRole('button', { name: 'Hand over' })).toBeEnabled()

  await waiting.getByRole('button', { name: 'Dismiss' }).click()
  await expect(waiting).toBeHidden()
  await expect(page.getByRole('main').locator('[data-dismissed]')).toHaveCount(1)
})
