import {
  listedSubtasks,
  type AuditPage,
  type Envelope,
  type MessagePage,
  type PrInput,
  type SubtaskBrief,
  type Task,
  type TaskListEntry,
} from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { FANOUT, SEEDS, seedTask } from './support/subtasks.js'

const OPENED_PR = 'https://github.com/e2e/dash/pull/42'
const REVIEW_PR = 'https://github.com/e2e/review/pull/7'

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

test('a task shows running while a background subagent runs after its turn, until the subagent ends', async ({
  page,
  request,
}) => {
  const title = unique('Subagent still working')
  const id = await seedTask(title, paths.checkout, SEEDS.fanOut())
  const finished = await apiData<SubtaskBrief[]>(request, `/tasks/${id}/subtasks`)
  const history = await apiData<MessagePage>(request, `/tasks/${id}/messages`)
  let working = true
  const briefs = () =>
    finished.map((brief) =>
      working && brief.tool_use_id === FANOUT.dashboard.id
        ? { ...brief, status: 'running' as const, ended_at: null }
        : brief,
    )
  await page.route('**/api/tasks', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Envelope<TaskListEntry[]>
    const data = body.data.map((task) => (task.id === id ? { ...task, ...listedSubtasks(briefs()) } : task))
    await route.fulfill({ response, json: { ...body, data } })
  })
  await page.route(new RegExp(`/api/tasks/${id}/stream`), async (route) => {
    const events = sse('backlog', { messages: history.messages, has_older: false }) + sse('subtasks', briefs())
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `retry: 300\n\n${events}`,
    })
  })

  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const header = main.getByRole('heading', { name: title }).locator('..')
  const listItem = main.getByRole('button', { name: new RegExp(title) })
  await expect(header.getByText('running', { exact: true })).toHaveAttribute('title', '1 subagent running')
  await expect(listItem.getByRole('img', { name: 'running', exact: true })).toHaveAttribute(
    'title',
    'running: 1 subagent running',
  )

  working = false
  await expect(header.getByText('idle', { exact: true })).toBeVisible()
  await expect(header.getByText('running', { exact: true })).toHaveCount(0)
  await expect(listItem.getByRole('img', { name: 'idle' })).toBeVisible()
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})

test('shows the PRs of a subagent, links and unlinks them by hand, and marks updates routed to it', async ({
  page,
  request,
}) => {
  const title = unique('Subagent PRs')
  const id = await seedTask(title, paths.checkout, SEEDS.fanOut())
  const db = openSeedDb()
  const ts = new Date().toISOString()
  await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'agent')`, id, OPENED_PR, ts)
  await db.run(
    `INSERT INTO subtask_pr (task_id, pr_url, tool_use_id, linked_at, source) VALUES (?, ?, ?, ?, 'agent')`,
    id,
    OPENED_PR,
    FANOUT.dashboard.id,
    ts,
  )
  const update: PrInput = {
    source: 'pr',
    kind: 'ci_failed',
    subject: 'e2e/dash#42',
    title: 'CI failed on e2e/dash#42',
    body: 'Failing checks on abc1234:\n- unit (failure)',
    url: OPENED_PR,
    subtask: {
      tool_use_id: FANOUT.dashboard.id,
      description: FANOUT.dashboard.description,
      agent_id: 'a_dash',
      running: false,
    },
  }
  await db.message(id, 'input', JSON.stringify(update), ts)
  await db.close()

  await page.goto(`/#agents/${id}`)
  const transcript = page.getByRole('region', { name: 'Transcript' })
  const cards = transcript.getByTestId('subtask-card')
  await expect(cards.nth(0).getByTestId('subtask-pr')).toHaveText('dash#42')
  await expect(cards.nth(0).getByTestId('subtask-pr')).toHaveAttribute('href', OPENED_PR)
  await expect(cards.nth(1).getByTestId('subtask-pr')).toHaveCount(0)
  const routed = transcript.locator('[data-kind="input"]')
  await expect(routed.getByTestId('input-subtask')).toHaveText(FANOUT.dashboard.description)
  await expect(routed).toContainText('queued')

  await routed.getByRole('button', { name: FANOUT.dashboard.description }).click()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}/sub/${FANOUT.dashboard.id}$`))
  const main = page.getByRole('main')
  await expect(main.getByRole('group', { name: 'Pull request dash#42' })).toBeVisible()
  const inSubtask = page.getByRole('region', { name: 'Transcript' }).locator('[data-kind="input"]')
  await expect(inSubtask).toContainText('CI failed on e2e/dash#42')
  await expect(inSubtask).not.toContainText('queued')

  await page.goto(`/#agents/${id}/sub/${FANOUT.agent.id}`)
  await expect(main.getByRole('heading', { name: FANOUT.agent.description })).toBeVisible()
  const prs = main.getByTestId('subtask-prs')
  await prs.getByRole('button', { name: 'Link PR' }).click()
  const picker = page.getByRole('dialog')
  await picker.getByLabel('Pull request URL').fill(REVIEW_PR)
  await picker.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(picker).toBeHidden()
  const linked = prs.getByRole('group', { name: 'Pull request review#7' })
  await expect(linked).toBeVisible()
  expect((await apiData<Task>(request, `/tasks/${id}`)).pr_urls).toEqual([OPENED_PR, REVIEW_PR])
  const agentBrief = async () =>
    (await apiData<SubtaskBrief[]>(request, `/tasks/${id}/subtasks`)).find((s) => s.tool_use_id === FANOUT.agent.id)
  expect((await agentBrief())?.pr_urls).toEqual([REVIEW_PR])

  await linked.getByRole('button', { name: 'Unlink review#7' }).click()
  await expect(linked).toBeHidden()
  expect((await agentBrief())?.pr_urls).toEqual([])
  expect((await apiData<Task>(request, `/tasks/${id}`)).pr_urls).toEqual([OPENED_PR, REVIEW_PR])
  const audit = await apiData<AuditPage>(request, `/audit?kind=task&q=${id}&limit=10`)
  expect(audit.events.map((e) => e.summary).slice(0, 3)).toEqual([
    `Unlinked PR e2e/review#7 from subagent "${FANOUT.agent.description}"`,
    `Linked PR e2e/review#7 to subagent "${FANOUT.agent.description}"`,
    'Linked PR e2e/review#7',
  ])
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})

test('a subagent card with several PRs folds them behind a count and never scrolls sideways', async ({ page }) => {
  const id = await seedTask(unique('Subagent many PRs'), paths.checkout, SEEDS.fanOut())
  const db = openSeedDb()
  const ts = new Date().toISOString()
  const urls = [1, 2, 3, 4].map((n) => `https://github.com/e2e/dashboard-with-a-long-name/pull/${String(n)}`)
  for (const url of urls) {
    await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'agent')`, id, url, ts)
    await db.run(
      `INSERT INTO subtask_pr (task_id, pr_url, tool_use_id, linked_at, source) VALUES (?, ?, ?, ?, 'agent')`,
      id,
      url,
      FANOUT.dashboard.id,
      ts,
    )
  }
  await db.close()

  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(`/#agents/${id}`)
  const transcript = page.getByRole('region', { name: 'Transcript' })
  const card = transcript.getByTestId('subtask-card').nth(0)
  const count = card.getByTestId('subtask-prs-count')
  await expect(count).toHaveText('4 PRs')
  await expect(card.getByTestId('subtask-pr')).toHaveCount(0)
  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const scroller = await transcript.evaluate((el) => {
    const wide = [el, ...el.querySelectorAll('*')].find(
      (node) =>
        node.scrollWidth > node.clientWidth + 1 &&
        getComputedStyle(node).overflowX !== 'hidden' &&
        getComputedStyle(node).overflowX !== 'visible',
    )
    return wide === undefined ? null : wide.tagName
  })
  expect(scroller).toBeNull()
  await count.click()
  const list = page.getByRole('list', { name: 'Pull requests of this subagent' })
  await expect(list.getByTestId('subtask-pr')).toHaveCount(4)
  await expect(list.getByTestId('subtask-pr').first()).toHaveAttribute('href', urls[0] ?? '')
})
