import type { Task, TaskListEntry } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { endSession, runTurn } from './runner.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

/** Each turn answers at once, except one asked to wait, which runs until the test releases it. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const held: (() => void)[] = []
  const fake = new FakeSdk(async function* ({ text, signal }) {
    yield fakeAssistant(`answer to: ${text}`)
    if (text === 'wait') {
      await new Promise<void>((resolve) => {
        held.push(resolve)
        signal.addEventListener('abort', () => {
          resolve()
        })
      })
    }
    yield fakeResult()
  })
  return { held, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const created: string[] = []

async function newTask(): Promise<string> {
  const id = `seen-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  return id
}

async function call<T>(method: string, path: string): Promise<T> {
  const res = await app.request(`/api/tasks${path}`, { method, headers })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const unseen = async (id: string) => (await call<Task>('GET', `/${id}`)).unseen

async function finishTurn(id: string, prompt = 'hello'): Promise<void> {
  await runTurn(id, prompt)
  await waitIdle(id)
}

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('unseen agents', () => {
  it('marks an agent unseen when its turn ends, on the task and its list entry', async () => {
    const id = await newTask()
    expect(await unseen(id)).toBe(false)

    await finishTurn(id)

    expect(await unseen(id)).toBe(true)
    const entry = (await call<TaskListEntry[]>('GET', '')).find((task) => task.id === id)
    expect(entry?.unseen).toBe(true)
  })

  it('clears it once the user looked, until the next turn ends', async () => {
    const id = await newTask()
    await finishTurn(id)

    const seen = await call<Task>('POST', `/${id}/seen`)

    expect(seen.unseen).toBe(false)
    expect(await unseen(id)).toBe(false)
    await finishTurn(id, 'again')
    expect(await unseen(id)).toBe(true)
  })

  it('reads seen while a turn runs, and a look during it does not cover how it ends', async () => {
    const id = await newTask()
    await finishTurn(id)
    expect(await unseen(id)).toBe(true)

    await runTurn(id, 'wait')
    await vi.waitFor(() => {
      expect(sdk.held).toHaveLength(1)
    })
    expect(await unseen(id)).toBe(false)
    await call<Task>('POST', `/${id}/seen`)
    sdk.held.shift()?.()
    await waitIdle(id)

    expect(await unseen(id)).toBe(true)
  })

  it('answers 404 for an agent that does not exist', async () => {
    const res = await app.request('/api/tasks/no-such-agent/seen', { method: 'POST', headers })
    expect(res.status).toBe(404)
  })
})
