import type { AgentTodo, MessageBody, TaskListEntry } from '@seti/shared'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { runTurn, subscribe } from '../runner.js'
import { assistant, toolResult, toolUse } from '../subtask-fixtures.js'
import { USER_AUTH } from '../test-auth.js'

/** A turn that plans two items with the task tools and works through the first. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('../fake-sdk.js')
  const state = { script: (): unknown[] => [] }
  const fake = new FakeSdk(async function* () {
    yield* state.script() as { type: string }[]
    yield await Promise.resolve(fakeResult())
  })
  return { state, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const TASK = 'todo-task'
const app = createApp()

async function list(): Promise<TaskListEntry[]> {
  const res = await app.request('/api/tasks', { headers: { host: 'localhost', ...USER_AUTH } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: TaskListEntry[] }).data
}

const payload = (body: MessageBody): unknown => body.payload

const create = (id: string, taskId: string, subject: string) => [
  payload(assistant([toolUse(id, 'TaskCreate', { subject, description: subject, activeForm: `${subject}...` })])),
  payload(
    toolResult(id, `Task #${taskId} created successfully: ${subject}`, { output: { task: { id: taskId, subject } } }),
  ),
]

beforeAll(async () => {
  await tasks.insert({ id: TASK, title: 'Plan', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
})

describe('agent todos', () => {
  it('publishes the todo list as the agent changes it and lists it with the task', async () => {
    expect((await list()).find((task) => task.id === TASK)?.todos).toEqual([])
    sdk.state.script = () => [
      ...create('c1', '1', 'Read'),
      ...create('c2', '2', 'Fix'),
      payload(assistant([toolUse('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' })])),
      payload(toolResult('u1', 'Updated task #1 status', { output: { success: true } })),
    ]
    const seen: AgentTodo[][] = []
    const unsubscribe = subscribe(TASK, (event) => {
      if (event.type === 'todos') {
        seen.push(event.todos)
      }
    })
    await runTurn(TASK, 'plan it')
    await vi.waitFor(() => {
      expect(seen.at(-1)?.map((todo) => todo.status)).toEqual(['in_progress', 'pending'])
    })
    unsubscribe()
    expect(seen.map((todos) => todos.length)).toEqual([1, 2, 2])
    const entry = (await list()).find((task) => task.id === TASK)
    expect(entry?.todos).toEqual([
      { id: '1', content: 'Read', active_form: 'Read...', status: 'in_progress' },
      { id: '2', content: 'Fix', active_form: 'Fix...', status: 'pending' },
    ])
  })
})
