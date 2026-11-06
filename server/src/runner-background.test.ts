import type { TaskStatus } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { messages, tasks } from './db.js'
import { fakeAssistant, fakeBackground, fakeMessage, fakeResult, type FakeSession } from './fake-sdk.js'
import { endSession, isRunning, runTurn, sessionState, stopTurn, subscribe } from './runner.js'
import { waitIdle } from './wait-idle.js'

/** Each turn ends with its result at once; background work reports back through emit(). */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult: result } = await import('./fake-sdk.js')
  const fake = new FakeSdk(function* () {
    yield result()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

let taskCount = 0

async function newTask(): Promise<string> {
  const id = `background-task-${String(++taskCount)}`
  await tasks.insert({ id, title: 'Background', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  return id
}

const status = async (id: string): Promise<TaskStatus | undefined> => (await tasks.get(id))?.status
const results = async (id: string) =>
  (await messages.page(id, 100)).messages.filter((row) => row.kind === 'sdk' && row.payload.type === 'result').length

async function turn(id: string, prompt: string): Promise<FakeSession> {
  await runTurn(id, prompt)
  await waitIdle(id)
  const last = sdk.fake.last
  if (!last) {
    throw new Error('No session started')
  }
  return last
}

/** A task whose session keeps a dev server running in the background. */
async function withDevServer(): Promise<{ id: string; session: FakeSession }> {
  const id = await newTask()
  const session = await turn(id, 'start a dev server')
  session.emit(fakeBackground('dev-server'))
  await vi.waitFor(() => {
    expect(sessionState(id)).toEqual({ open: true, background: 1 })
  })
  return { id, session }
}

describe('sessions that background work keeps busy between turns', () => {
  it('ends the turn at its result, then runs again when background work reports back', async () => {
    const { id, session } = await withDevServer()
    expect(await status(id)).toBe('idle')
    expect(isRunning(id)).toBe(false)

    session.emit(fakeMessage('system', { subtype: 'init', model: 'claude', permissionMode: 'bypassPermissions' }))
    session.emit(fakeAssistant('the dev server is up'))
    session.emit(fakeResult())
    await vi.waitFor(async () => {
      expect(await results(id)).toBe(2)
    })
    await waitIdle(id)
    expect(await status(id)).toBe('idle')
  })

  it('sends the next message into the same session, where background work keeps running', async () => {
    const { id, session } = await withDevServer()
    const sessions = sdk.fake.sessions.length
    const seen: TaskStatus[] = []
    const unsubscribe = subscribe(id, (event) => {
      if (event.type === 'status') {
        seen.push(event.status)
      }
    })
    await runTurn(id, 'next')
    expect(seen[0]).toBe('running')
    await waitIdle(id)
    unsubscribe()
    expect(await turn(id, 'again')).toBe(session)
    expect(sdk.fake.sessions).toHaveLength(sessions)
    expect(session.prompts).toEqual(['start a dev server', 'next', 'again'])
    expect(session.closed).toBe(false)
    expect(sdk.fake.aborted).toEqual([])
  })

  it('leaves background work to Stop, and ends it with the session without marking the turn stopped', async () => {
    const { id, session } = await withDevServer()
    await expect(stopTurn(id)).rejects.toThrow('Task is not running')
    expect(session.closed).toBe(false)
    await endSession(id)
    expect(session.closed).toBe(true)
    expect(sessionState(id)).toEqual({ open: false, background: 0 })
    expect(await status(id)).toBe('idle')
    expect(await turn(id, 'start over')).not.toBe(session)
  })

  it('stays idle while only a background subagent works', async () => {
    const id = await newTask()
    const session = await turn(id, 'fan out')
    expect(await status(id)).toBe('idle')
    const before = await results(id)
    const statuses: TaskStatus[] = []
    const unsubscribe = subscribe(id, (event) => {
      if (event.type === 'status') {
        statuses.push(event.status)
      }
    })
    session.emit(fakeBackground('subagent'))
    session.emit(
      fakeMessage('assistant', {
        parent_tool_use_id: 'toolu_subagent',
        message: { content: [{ type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } }] },
      }),
    )
    await vi.waitFor(async () => {
      expect((await messages.page(id, 5)).messages.at(-1)?.kind).toBe('sdk')
    })
    await waitIdle(id)
    expect(statuses).toEqual([])

    session.emit(fakeBackground())
    session.emit(fakeAssistant('background task finished'))
    session.emit(fakeResult())
    await vi.waitFor(async () => {
      expect(await results(id)).toBe(before + 1)
    })
    await waitIdle(id)
    unsubscribe()
    expect(statuses).toEqual(['running', 'idle'])
    expect(await status(id)).toBe('idle')
  })
})
