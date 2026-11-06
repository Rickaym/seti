import { listedSubtasks, prStates, type SubtaskBrief, type TaskListEntry } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { prDismissals } from './store/pr-discovery.js'
import { prWatch } from './store/pr-watch.js'
import { agentCall, launched, taskNotification, taskProgress, taskStarted } from './subtask-fixtures.js'
import { USER_AUTH } from './test-auth.js'

const LEAD = 'list-size-lead'
const SUBTASKS = 1000
const UNLINKED_PRS = 700
const LINKED_PR = 'https://github.com/acme/app/pull/1'
const unlinkedPr = (n: number) => `https://github.com/acme/app/pull/${String(n + 2)}`
const LIST_BUDGET_BYTES = 100_000
const ENTRY_BUDGET_BYTES = 4_000

const app = createApp()
const get = async (path: string) => app.request(`/api/tasks${path}`, { headers: { host: 'localhost', ...USER_AUTH } })

/** The response body as sent, so its size is the one on the wire before compression. */
async function text(path: string): Promise<string> {
  const res = await get(path)
  expect(res.status, path).toBe(200)
  return res.text()
}

const brief = (n: number, status: SubtaskBrief['status']): SubtaskBrief => ({
  tool_use_id: `toolu_${String(n)}`,
  tool_use_ids: [`toolu_${String(n)}`],
  parent_tool_use_id: null,
  message_id: n,
  sdk_task_id: null,
  description: `Subtask ${String(n)}`,
  subagent_type: null,
  background: true,
  status,
  progress: null,
  usage: null,
  started_at: '2026-10-01T00:00:00Z',
  ended_at: status === 'running' ? null : '2026-10-01T00:01:00Z',
  summary: null,
  pr_urls: [],
})

/** One background subagent with the progress, usage and summary text live ones carry. */
async function seedSubagent(n: number): Promise<void> {
  const id = `toolu_lead_${String(n)}`
  const agent = `agent_${String(n)}`
  const description = `Review service ${String(n)} for regressions after the release`
  const rows = [
    agentCall(id, description, { run_in_background: true }),
    taskStarted({ taskId: agent, toolUseId: id, description, background: true }),
    launched(id, agent),
    taskProgress(agent, id, 'Bash', 12),
    taskNotification(
      agent,
      id,
      n % 50 === 0 ? 'failed' : 'completed',
      `Reviewed service ${String(n)}: two flaky tests, one missing index and a slow query to follow up.`,
    ),
  ]
  for (const row of rows) {
    await messages.insert(LEAD, row, [])
  }
}

beforeAll(async () => {
  await tasks.insert({
    id: LEAD,
    title: 'Eng lead',
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [LINKED_PR],
  })
  await messages.insert(LEAD, { kind: 'prompt', payload: { text: 'Run the reviews' } }, [])
  for (let n = 0; n < SUBTASKS; n++) {
    await seedSubagent(n)
  }
  await prWatch.save(LINKED_PR, { state: 'open', conflicting: false, ci: null, review_ids: [], comment_ids: [] })
  for (let n = 0; n < UNLINKED_PRS; n++) {
    await prDismissals.add(LEAD, unlinkedPr(n))
    await prWatch.save(unlinkedPr(n), {
      state: 'merged',
      conflicting: false,
      ci: null,
      review_ids: [],
      comment_ids: [],
    })
  }
}, 300_000)

describe('the task list with a long-lived agent', () => {
  it(`stays under ${String(LIST_BUDGET_BYTES)} bytes with ${String(SUBTASKS)} subtasks on one agent`, async () => {
    const sent = await text('')
    const body = (JSON.parse(sent) as { data: TaskListEntry[] }).data
    const lead = body.find((task) => task.id === LEAD)
    expect(lead?.subtask_counts).toEqual({ running: 0, completed: 980, failed: 20, stopped: 0, unknown: 0 })
    expect(lead?.running_subtasks).toEqual([])
    expect(lead?.pr_states).toEqual({ by_url: { [LINKED_PR]: 'open' }, any_merged: true })
    expect(Buffer.byteLength(sent)).toBeLessThan(LIST_BUDGET_BYTES)
    expect(Buffer.byteLength(JSON.stringify(lead))).toBeLessThan(ENTRY_BUDGET_BYTES)
  })

  it('still serves every subtask from the per-task endpoint', async () => {
    const sent = await text(`/${LEAD}/subtasks`)
    expect((JSON.parse(sent) as { data: SubtaskBrief[] }).data).toHaveLength(SUBTASKS)
    expect(Buffer.byteLength(sent)).toBeGreaterThan(LIST_BUDGET_BYTES)
  })
})

describe('listedSubtasks', () => {
  it('counts every status and keeps only the running subtasks', () => {
    const subtasks = [
      brief(0, 'running'),
      ...Array.from({ length: 30 }, (_, i) => brief(i + 1, i % 3 === 0 ? 'failed' : 'completed')),
      brief(31, 'running'),
      brief(32, 'unknown'),
      brief(33, 'stopped'),
    ]
    const { running_subtasks, subtask_counts } = listedSubtasks(subtasks)
    expect(subtask_counts).toEqual({ running: 2, completed: 20, failed: 10, stopped: 1, unknown: 1 })
    expect(running_subtasks.map((sub) => sub.message_id)).toEqual([0, 31])
  })

  it('keeps every running subtask however many run', () => {
    const subtasks = Array.from({ length: 40 }, (_, i) => brief(i, 'running'))
    expect(listedSubtasks(subtasks).running_subtasks).toHaveLength(40)
  })
})

describe('prStates', () => {
  it('narrows the states it carries but still counts an unlinked merged PR', () => {
    const states = prStates({ a: 'open', b: 'merged', c: 'closed' }, new Set(['a', 'c']))
    expect(states).toEqual({ by_url: { a: 'open', c: 'closed' }, any_merged: true })
    expect(prStates({ a: 'closed' })).toEqual({ by_url: { a: 'closed' }, any_merged: false })
  })
})
