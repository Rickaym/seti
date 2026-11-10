import { listedStatus, needsYou, type Task, type TaskListEntry } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { endSession, runTurn } from './runner.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

/** Answers each prompt by its first word: a question, a question tool, a failure, a held turn. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeMessage, fakeResult } = await import('./fake-sdk.js')
  const held: (() => void)[] = []
  const fake = new FakeSdk(async function* ({ text, signal }) {
    const [verb] = text.split(' ')
    if (verb === 'question') {
      yield fakeAssistant('The tests pass.\n\nShould I open the PR now?')
    } else if (verb === 'picker') {
      const content = [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: {} }]
      yield fakeMessage('assistant', { parent_tool_use_id: null, message: { content } })
    } else if (verb === 'fail') {
      yield fakeAssistant('Which token should I use?')
      yield fakeResult(true)
      return
    } else if (verb === 'wait') {
      await new Promise<void>((resolve) => {
        held.push(resolve)
        signal.addEventListener('abort', () => {
          resolve()
        })
      })
    } else {
      yield fakeAssistant('Done.')
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
  const id = `asking-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  return id
}

async function read<T>(path: string): Promise<T> {
  const res = await app.request(`/api/tasks${path}`, { headers })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const asking = async (id: string) => (await read<Task>(`/${id}`)).asking

async function finishTurn(id: string, prompt: string): Promise<void> {
  await runTurn(id, prompt)
  await waitIdle(id)
}

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('agents asking the user', () => {
  it('marks a turn that ends on a question, which puts the agent in Needs you', async () => {
    const id = await newTask()
    await finishTurn(id, 'question')

    expect(await asking(id)).toBe(true)
    const entry = (await read<TaskListEntry[]>('')).find((task) => task.id === id)
    expect(entry?.asking).toBe(true)
    const status = entry && listedStatus(entry)
    expect(status).toBe('asking')
    expect(status !== undefined && needsYou(status)).toBe(true)
  })

  it('clears it as soon as the next message starts a turn, and keeps it off after a plain answer', async () => {
    const id = await newTask()
    await finishTurn(id, 'question')
    expect(await asking(id)).toBe(true)

    await runTurn(id, 'wait for it')
    await vi.waitFor(() => {
      expect(sdk.held).toHaveLength(1)
    })
    const [stored] = await sql<{ asking: boolean }[]>`SELECT asking FROM task WHERE id = ${id}`
    expect(stored?.asking).toBe(false)
    sdk.held.shift()?.()
    await waitIdle(id)
    expect(await asking(id)).toBe(false)

    await finishTurn(id, 'question')
    await finishTurn(id, 'thanks')
    expect(await asking(id)).toBe(false)
  })

  it('does not mark a turn whose last tool use was AskUserQuestion, which waits as questions', async () => {
    const id = await newTask()
    await finishTurn(id, 'picker')
    expect(await asking(id)).toBe(false)
  })

  it('leaves a failed turn as an error, even when it ended on a question', async () => {
    const id = await newTask()
    await finishTurn(id, 'fail')
    const task = await read<Task>(`/${id}`)
    expect(task.status).toBe('error')
    expect(task.asking).toBe(false)
  })
})
