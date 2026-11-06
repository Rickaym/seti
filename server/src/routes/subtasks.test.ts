import type { MessageBody, MessagePage, Subtask, SubtaskBrief, TaskDigest, TaskListEntry } from '@seti/shared'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { messages, tasks } from '../db.js'
import { runTurn, subscribe } from '../runner.js'
import {
  agentCall,
  assistant,
  bash,
  completedResult,
  launched,
  taskNotification,
  taskProgress,
  taskStarted,
  toolResult,
} from '../subtask-fixtures.js'
import { USER_AUTH } from '../test-auth.js'

/** A turn that starts one background subagent, then waits for an interrupt or finish(). */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('../fake-sdk.js')
  const state = {
    finish: (): void => undefined,
    script: (): unknown[] => [],
    stoppedMessage: (_taskId: string): unknown => null,
  }
  const fake = new FakeSdk(async function* ({ signal }) {
    yield* state.script() as { type: string }[]
    const finished = await new Promise<boolean>((resolve) => {
      state.finish = () => {
        resolve(true)
      }
      signal.addEventListener('abort', () => {
        resolve(false)
      })
    })
    if (finished) {
      yield fakeResult()
    }
  })
  fake.onStopTask = (session, taskId) => {
    session.emit(state.stoppedMessage(taskId) as { type: string })
  }
  return { state, fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const TASK = 'subtask-task'
const LIVE = 'subtask-live'
const app = createApp()

const request = async (path: string, method = 'GET') =>
  app.request(`/api/tasks${path}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
  })

async function data<T>(path: string): Promise<T> {
  const res = await request(path)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

async function insert(taskId: string, ...bodies: MessageBody[]): Promise<void> {
  for (const body of bodies) {
    await messages.insert(taskId, body, [])
  }
}

const payload = (body: MessageBody): unknown => body.payload

beforeAll(async () => {
  await tasks.insert({ id: TASK, title: 'Fan out', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.insert({ id: LIVE, title: 'Live fan out', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await insert(
    TASK,
    { kind: 'prompt', payload: { text: 'Review both services' } },
    agentCall('toolu_a', 'Review dashboard'),
    taskStarted({ taskId: 'a1', toolUseId: 'toolu_a', description: 'Review dashboard', background: true }),
    launched('toolu_a', 'a1'),
    agentCall('toolu_b', 'Review agent', { run_in_background: false }),
    taskStarted({ taskId: 'a2', toolUseId: 'toolu_b', description: 'Review agent', background: false }),
  )
  for (let i = 0; i < 12; i++) {
    await insert(TASK, bash(`toolu_a_${String(i)}`, `echo ${String(i)}`, 'toolu_a'))
    await insert(
      TASK,
      toolResult(`toolu_a_${String(i)}`, i === 11 ? 'z'.repeat(100_000) : `ok ${String(i)}`, { parent: 'toolu_a' }),
    )
    await insert(TASK, bash(`toolu_b_${String(i)}`, `ls ${String(i)}`, 'toolu_b'))
  }
  await insert(
    TASK,
    taskProgress('a1', 'toolu_a', 'Bash', 12),
    completedResult('toolu_b', 'a2', 'Agent service is fine.'),
    taskNotification('a1', 'toolu_a', 'completed', 'Dashboard review\n\nTwo issues found.'),
    assistant([{ type: 'text', text: 'Both reviews are back.' }]),
  )
})

describe('subtask routes', () => {
  it('counts subtasks in the task list and leaves the ended ones to the task', async () => {
    const list = await data<TaskListEntry[]>('')
    const entry = list.find((task) => task.id === TASK)
    expect(entry?.subtask_counts).toEqual({ running: 0, completed: 2, failed: 0, stopped: 0, unknown: 0 })
    expect(entry?.running_subtasks).toEqual([])
    expect(list.find((task) => task.id === LIVE)?.subtask_counts.completed).toBe(0)
  })

  it('lists a task subtasks and serves one with its prompt and report', async () => {
    const briefs = await data<SubtaskBrief[]>(`/${TASK}/subtasks`)
    expect(briefs).toHaveLength(2)
    expect(briefs[0]).not.toHaveProperty('prompt')
    const one = await data<Subtask>(`/${TASK}/subtasks/toolu_a`)
    expect(one).toMatchObject({
      prompt: 'Do this: Review dashboard',
      result: 'Dashboard review\n\nTwo issues found.',
      summary: 'Dashboard review',
      usage: { tool_uses: 9 },
    })
    expect((await request(`/${TASK}/subtasks/toolu_missing`)).status).toBe(404)
    expect((await request(`/missing/subtasks`)).status).toBe(404)
  })

  it('pages a subtask transcript with only its own rows, trimmed for the wire', async () => {
    const tail = await data<MessagePage>(`/${TASK}/subtasks/toolu_a/messages?limit=4`)
    expect(tail.has_older).toBe(true)
    expect(tail.messages).toHaveLength(4)
    const parents = tail.messages.map((row) => (row.kind === 'sdk' ? row.payload : null))
    expect(parents.every((p) => p !== null && 'parent_tool_use_id' in p && p.parent_tool_use_id === 'toolu_a')).toBe(
      true,
    )
    const last = tail.messages.at(-1)
    expect(last?.trimmed).toEqual(['toolu_a_11'])
    expect(JSON.stringify(last).length).toBeLessThan(20_000)

    const oldest = tail.messages[0]?.id ?? 0
    const rest = await data<MessagePage>(`/${TASK}/subtasks/toolu_a/messages?before=${String(oldest)}&limit=100`)
    expect(rest.messages).toHaveLength(20)
    expect(rest.has_older).toBe(false)
    expect((await request(`/${TASK}/subtasks/toolu_a/messages?limit=0`)).status).toBe(400)
  })

  it('summarises each subagent as one digest line', async () => {
    const { lines } = await data<TaskDigest>(`/${TASK}/digest?limit=10`)
    expect(lines.filter((line) => line.kind === 'subtask').map((line) => line.text)).toEqual([
      expect.stringMatching(
        /^Subtask "Review dashboard" \(general-purpose, background\): completed( in \d+s)?: Dashboard review\.$/,
      ),
      expect.stringMatching(
        /^Subtask "Review agent" \(general-purpose\): completed( in \d+s)?: Agent service is fine\.$/,
      ),
    ])
    expect(lines.some((line) => line.text.includes('echo'))).toBe(false)
  })

  it('refuses to stop a subagent that is not running', async () => {
    expect((await request(`/${TASK}/subtasks/toolu_a/stop`, 'POST')).status).toBe(409)
  })
})

describe('live subtasks', () => {
  it('publishes subtask changes and stops one subagent while the turn runs', async () => {
    sdk.state.script = () => [
      payload(agentCall('toolu_live', 'Watch CI')),
      payload(taskStarted({ taskId: 'a9', toolUseId: 'toolu_live', description: 'Watch CI', background: true })),
      payload(launched('toolu_live', 'a9')),
    ]
    sdk.state.stoppedMessage = (taskId) => payload(taskNotification(taskId, 'toolu_live', 'stopped', 'Watch CI'))
    const seen: SubtaskBrief[][] = []
    const unsubscribe = subscribe(LIVE, (event) => {
      if (event.type === 'subtasks') {
        seen.push(event.subtasks)
      }
    })
    await runTurn(LIVE, 'watch CI in the background')
    await vi.waitFor(() => {
      expect(seen.at(-1)?.[0]).toMatchObject({ sdk_task_id: 'a9', status: 'running', background: true })
    })
    const listed = (await data<TaskListEntry[]>('')).find((task) => task.id === LIVE)
    expect(listed?.subtask_counts.running).toBe(1)
    expect(listed?.running_subtasks.map((s) => [s.tool_use_id, s.description])).toEqual([['toolu_live', 'Watch CI']])

    const stopped = await request(`/${LIVE}/subtasks/toolu_live/stop`, 'POST')
    expect(stopped.status).toBe(200)
    expect(sdk.fake.last?.stoppedTasks).toEqual(['a9'])
    sdk.state.finish()
    await vi.waitFor(() => {
      expect(seen.at(-1)?.[0]?.status).toBe('stopped')
    })
    unsubscribe()
    const ended = (await data<TaskListEntry[]>('')).find((task) => task.id === LIVE)
    expect([ended?.running_subtasks, ended?.subtask_counts.stopped]).toEqual([[], 1])
    await vi.waitFor(async () => {
      expect((await tasks.get(LIVE))?.status).toBe('idle')
    })
    expect((await request(`/${LIVE}/subtasks/toolu_live/stop`, 'POST')).status).toBe(409)
  })

  it('stops a background subagent after the turn that started it ended', async () => {
    await tasks.insert({
      id: 'subtask-later',
      title: 'Later',
      repo_id: null,
      cwd: '/tmp',
      worktree: false,
      pr_urls: [],
    })
    sdk.state.script = () => [
      payload(agentCall('toolu_later', 'Soak test')),
      payload(taskStarted({ taskId: 'b7', toolUseId: 'toolu_later', description: 'Soak test', background: true })),
      payload(launched('toolu_later', 'b7')),
    ]
    sdk.state.stoppedMessage = (taskId) => payload(taskNotification(taskId, 'toolu_later', 'stopped', 'Soak test'))
    await runTurn('subtask-later', 'soak in the background')
    await vi.waitFor(() => {
      expect(sdk.fake.last?.current).toBe('soak in the background')
    })
    sdk.state.finish()
    await vi.waitFor(async () => {
      expect((await tasks.get('subtask-later'))?.status).toBe('idle')
    })
    expect(await data<Subtask>('/subtask-later/subtasks/toolu_later')).toMatchObject({ status: 'running' })

    expect((await request('/subtask-later/subtasks/toolu_later/stop', 'POST')).status).toBe(200)
    expect(sdk.fake.last?.stoppedTasks).toEqual(['b7'])
    await vi.waitFor(async () => {
      expect(await data<Subtask>('/subtask-later/subtasks/toolu_later')).toMatchObject({ status: 'stopped' })
    })
    expect((await tasks.get('subtask-later'))?.status).toBe('idle')
  })
})
