import type { Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { fakeAssistant, fakeBackground, fakeResult, type FakeSession } from '../fake-sdk.js'
import { isOutward } from '../outward.js'
import { runTurn, sessionState } from '../runner.js'
import { TASK_ID_ENV } from '../session-options.js'
import { waitIdle } from '../wait-idle.js'
import { SELF_TOOLS } from './self.js'
import { callSetiTool } from './server.js'

/** A turn whose prompt holds `status: <text>` sets that status; `background` leaves work running. */
const sdk = await vi.hoisted(async () => {
  const fakes = await import('../fake-sdk.js')
  const hooks: { setStatus: (taskId: string, text: string) => Promise<unknown> } = {
    setStatus: async () => Promise.reject(new Error('set_status is not wired yet')),
  }
  const fake = new fakes.FakeSdk(async function* (fakeTurn) {
    const status = /status: ([^;]*)/.exec(fakeTurn.text)?.[1]
    const taskId = fakeTurn.session.options.env?.SETI_TASK_ID
    if (status !== undefined && taskId !== undefined) {
      await hooks.setStatus(taskId, status)
    }
    if (fakeTurn.text.includes('background')) {
      yield fakes.fakeBackground('ci-watch')
    }
    yield fakes.fakeResult()
  })
  return { fake, query: fake.query, hooks }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

createApp()
let count = 0

async function newTask(): Promise<Task> {
  const id = `status-line-${String(++count)}`
  await tasks.insert({
    id,
    title: `Agent ${String(count)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
    seti_control: 'off',
  })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('task was not stored')
  }
  return task
}

const [setStatus] = SELF_TOOLS

async function call(caller: Task, args: unknown) {
  if (setStatus === undefined) {
    throw new Error('no set_status tool')
  }
  const result = await callSetiTool(setStatus, caller.id, args)
  return { text: result.content.map((block) => block.text).join(''), isError: 'isError' in result }
}

const line = async (id: string) => (await tasks.get(id))?.status_line ?? null

/** The status each turn's set_status call left on the row, read during the turn. */
const setInTurn: (string | null)[] = []

sdk.hooks.setStatus = async (taskId, text) => {
  if (setStatus !== undefined) {
    await callSetiTool(setStatus, taskId, { text })
  }
  setInTurn.push(await line(taskId))
}

async function turn(id: string, prompt: string): Promise<FakeSession> {
  await runTurn(id, prompt)
  await waitIdle(id)
  const last = sdk.fake.last
  if (!last) {
    throw new Error('No session started')
  }
  return last
}

describe('set_status', () => {
  it('shows a status on the calling agent row with its time, and an empty text clears it', async () => {
    const caller = await newTask()
    expect(caller.seti_control).toBe('off')
    const set = await call(caller, { text: '  waiting \n on   CI ' })
    expect(set).toEqual({ isError: false, text: expect.stringContaining('waiting on CI') as unknown })
    const stored = await tasks.get(caller.id)
    expect(stored).toMatchObject({ status_line: 'waiting on CI', status_line_at: expect.any(String) as unknown })
    expect(stored?.updated_at).toBe(caller.updated_at)
    expect((await call(caller, { text: '' })).isError).toBe(false)
    expect(await tasks.get(caller.id)).toMatchObject({ status_line: null, status_line_at: null })
  })

  it('refuses a status longer than 60 characters', async () => {
    const caller = await newTask()
    await call(caller, { text: 'running e2e' })
    const result = await call(caller, { text: 'x'.repeat(61) })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('60')
    expect(await line(caller.id)).toBe('running e2e')
    expect((await call(caller, { text: 'y'.repeat(60) })).isError).toBe(false)
  })

  it('sets only the calling agent status, whatever other agent the call names', async () => {
    const caller = await newTask()
    const other = await newTask()
    await call(caller, { text: 'running e2e', task: other.id })
    expect(await line(caller.id)).toBe('running e2e')
    expect(await line(other.id)).toBeNull()
  })

  it('is not an outward call', () => {
    expect(isOutward('mcp__seti__set_status', { text: 'waiting on CI' })).toBe(false)
    expect(isOutward('mcp__seti__post_team_chat', { text: 'hi' })).toBe(true)
  })
})

describe('the status line', () => {
  it('clears when the turn ends', async () => {
    const task = await newTask()
    await turn(task.id, 'status: running e2e')
    expect(setInTurn.at(-1)).toBe('running e2e')
    expect(await line(task.id)).toBeNull()
  })

  it('outlives a turn whose background work still runs, and clears when the next turn starts', async () => {
    const task = await newTask()
    const session = await turn(task.id, 'status: waiting on CI; background')
    await vi.waitFor(() => {
      expect(sessionState(task.id).background).toBe(1)
    })
    expect(session.options.env?.[TASK_ID_ENV]).toBe(task.id)
    expect(await line(task.id)).toBe('waiting on CI')
    await turn(task.id, 'next')
    expect(await line(task.id)).toBeNull()
  })

  it('keeps a status set after the turn ended when background work starts a turn', async () => {
    const task = await newTask()
    const session = await turn(task.id, 'status: waiting on CI; background')
    await vi.waitFor(() => {
      expect(sessionState(task.id).background).toBe(1)
    })
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
    await call(task, { text: 'CI passed, merging' })
    session.emit(fakeAssistant('CI finished'))
    await vi.waitFor(async () => {
      expect((await tasks.get(task.id))?.status).toBe('running')
    })
    expect(await line(task.id)).toBe('CI passed, merging')
    session.emit(fakeResult())
    await waitIdle(task.id)
    expect(await line(task.id)).toBe('CI passed, merging')
    session.emit(fakeBackground())
    await vi.waitFor(async () => {
      expect(await line(task.id)).toBeNull()
    })
  })

  it('clears on a Seti restart', async () => {
    const task = await newTask()
    await call(task, { text: 'waiting on CI' })
    await tasks.markInterrupted()
    expect(await line(task.id)).toBeNull()
  })
})
