import type { MessageBody, MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { assistant, toolResult, toolUse } from './subtask-fixtures.js'
import { deriveTodos, TodoIndex } from './todos.js'

function rows(...bodies: MessageBody[]): MessageRow[] {
  return bodies.map((body, index) => ({
    ...body,
    id: index + 1,
    task_id: 'task',
    outward: [],
    created_at: new Date(Date.UTC(2026, 9, 20, 12, 0, index)).toISOString(),
  }))
}

const init = (session: string) =>
  ({ kind: 'sdk', payload: { type: 'system', subtype: 'init', session_id: session, uuid: session } }) as MessageBody

const todo = (content: string, status: string, activeForm = `${content}ing`) => ({ content, status, activeForm })

const write = (id: string, todos: unknown[], parent: string | null = null) => [
  assistant([toolUse(id, 'TodoWrite', { todos })], parent),
  toolResult(id, 'Todos have been modified successfully.', parent === null ? {} : { parent }),
]

const create = (id: string, taskId: string, subject: string, activeForm?: string) => [
  assistant([
    toolUse(id, 'TaskCreate', { subject, description: subject, ...(activeForm === undefined ? {} : { activeForm }) }),
  ]),
  toolResult(id, `Task #${taskId} created successfully: ${subject}`, { output: { task: { id: taskId, subject } } }),
]

const update = (id: string, input: Record<string, unknown>, output: Record<string, unknown> = { success: true }) => [
  assistant([toolUse(id, 'TaskUpdate', input)]),
  toolResult(id, `Updated task #${String(input.taskId)} status`, { output }),
]

describe('deriveTodos from TodoWrite', () => {
  it('takes the latest list the agent wrote, with each status and active form', () => {
    const todos = deriveTodos(
      rows(
        init('s1'),
        ...write('w1', [todo('Read', 'in_progress'), todo('Fix', 'pending'), todo('Test', 'pending')]),
        ...write('w2', [
          todo('Read', 'completed'),
          todo('Fix', 'in_progress', 'Fixing the bug'),
          todo('Test', 'pending'),
        ]),
      ),
    )
    expect(todos).toEqual([
      { id: '1', content: 'Read', active_form: 'Reading', status: 'completed' },
      { id: '2', content: 'Fix', active_form: 'Fixing the bug', status: 'in_progress' },
      { id: '3', content: 'Test', active_form: 'Testing', status: 'pending' },
    ])
  })

  it('keeps the finished list once every item is done, and empties on an empty write', () => {
    const done = rows(...write('w1', [todo('Read', 'completed'), todo('Fix', 'completed')]))
    expect(deriveTodos(done).map((item) => item.status)).toEqual(['completed', 'completed'])
    expect(deriveTodos([...done, ...rows(...write('w2', [])).map((row) => ({ ...row, id: row.id + 10 }))])).toEqual([])
  })

  it("ignores a subagent's own list, a refused write and one still waiting for its result", () => {
    const own = write('w1', [todo('Plan', 'in_progress')])
    const todos = deriveTodos(
      rows(
        ...own,
        ...write('w2', [todo('Sub step', 'in_progress')], 'agent-call'),
        assistant([toolUse('w3', 'TodoWrite', { todos: [todo('Denied', 'pending')] })]),
        toolResult('w3', 'The user denied this', { isError: true }),
        assistant([toolUse('w4', 'TodoWrite', { todos: [todo('Pending', 'pending')] })]),
      ),
    )
    expect(todos.map((item) => item.content)).toEqual(['Plan'])
  })
})

describe('deriveTodos from the task tools', () => {
  it('builds the list from creates and follows updates through completion and deletion', () => {
    const todos = deriveTodos(
      rows(
        init('s1'),
        ...create('c1', '1', 'Write a.txt', 'Writing a.txt'),
        ...create('c2', '2', 'Write b.txt'),
        ...create('c3', '3', 'Report'),
        ...update('u1', { taskId: '1', status: 'in_progress' }),
        ...update('u2', { taskId: '1', status: 'completed' }),
        ...update('u3', { taskId: '2', status: 'deleted' }),
        ...update('u4', { taskId: '3', status: 'in_progress', subject: 'Report back', activeForm: 'Reporting' }),
      ),
    )
    expect(todos).toEqual([
      { id: '1', content: 'Write a.txt', active_form: 'Writing a.txt', status: 'completed' },
      { id: '3', content: 'Report back', active_form: 'Reporting', status: 'in_progress' },
    ])
  })

  it('reads the created id from the result text when the structured output is missing', () => {
    const todos = deriveTodos(
      rows(
        assistant([toolUse('c1', 'TaskCreate', { subject: 'Ship' })]),
        toolResult('c1', 'Task #7 created successfully: Ship'),
      ),
    )
    expect(todos).toEqual([{ id: '7', content: 'Ship', active_form: null, status: 'pending' }])
  })

  it('skips failed updates and settles the list on what TaskList reports', () => {
    const todos = deriveTodos(
      rows(
        ...create('c1', '1', 'One', 'Doing one'),
        ...create('c2', '2', 'Two'),
        ...update('u1', { taskId: '9', status: 'completed' }, { success: false, error: 'Task #9 not found' }),
        assistant([toolUse('l1', 'TaskList', {})]),
        toolResult('l1', '#1 [completed] One\n#3 [pending] Three', {
          output: {
            tasks: [
              { id: '1', subject: 'One', status: 'completed', blockedBy: [] },
              { id: '3', subject: 'Three', status: 'pending', blockedBy: [] },
            ],
          },
        }),
      ),
    )
    expect(todos).toEqual([
      { id: '1', content: 'One', active_form: 'Doing one', status: 'completed' },
      { id: '3', content: 'Three', active_form: null, status: 'pending' },
    ])
  })

  it('counts task tool calls a subagent makes, since the session shares one list', () => {
    const todos = deriveTodos(
      rows(
        ...create('c1', '1', 'Shared'),
        assistant([toolUse('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' })], 'agent-call'),
        toolResult('u1', 'Updated task #1 status', { parent: 'agent-call', output: { success: true } }),
      ),
    )
    expect(todos.map((item) => item.status)).toEqual(['in_progress'])
  })

  it('starts an empty list with a new session, and keeps it when the same one resumes', () => {
    const before = rows(init('s1'), ...create('c1', '1', 'Old'), init('s1'))
    expect(deriveTodos(before)).toHaveLength(1)
    expect(deriveTodos([...before, ...rows(init('s2')).map((row) => ({ ...row, id: 100 }))])).toEqual([])
  })
})

describe('TodoIndex', () => {
  it('reports a change only when the list changed, and ignores rows it has seen', () => {
    const index = new TodoIndex()
    const [call, result, again] = rows(...create('c1', '1', 'One'), init('s1'))
    if (call === undefined || result === undefined || again === undefined) {
      throw new Error('rows missing')
    }
    expect(index.apply(call)).toBe(false)
    expect(index.apply(result)).toBe(true)
    expect(index.apply(result)).toBe(false)
    expect(index.apply(again)).toBe(false)
    expect(index.todos()).toHaveLength(1)
  })
})
