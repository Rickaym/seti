import type { TaskEvent } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { archiveTask } from './archive.js'
import { messages, tasks } from './db.js'
import type { FakeSession } from './fake-sdk.js'
import { sessionMcp } from './mcp-session-status.js'
import { runTurn, sessionState, subscribe } from './runner.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

/** Turns echo the session they resume; `hold` turns run until interrupted, `fan out` leaves work. */
const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const created = new WeakMap<object, string>()
  let fresh = 0
  const fake = new fakes.FakeSdk(async function* ({ text, signal, session }) {
    const resumed = session.options.resume
    const id = resumed ?? created.get(session) ?? `new-${String(++fresh)}`
    created.set(session, id)
    yield fakes.fakeMessage('system', { subtype: 'init', session_id: id, model: 'haiku', permissionMode: 'default' })
    if (text.includes('hold')) {
      await fakes.aborted(signal)
      return
    }
    if (text.includes('fan out')) {
      yield fakes.fakeBackground('shell-1')
    }
    yield fakes.fakeAssistant(`resumed ${String(resumed)}: ${text}`)
    yield fakes.fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
let taskCount = 0

async function newTask(): Promise<string> {
  const id = `restart-task-${String(++taskCount)}`
  await tasks.insert({
    id,
    title: `Restart ${String(taskCount)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
  })
  return id
}

function lastSession(): FakeSession {
  const last = sdk.fake.last
  if (!last) {
    throw new Error('No session started')
  }
  return last
}

async function turn(taskId: string, prompt: string): Promise<FakeSession> {
  await runTurn(taskId, prompt)
  await waitIdle(taskId)
  return lastSession()
}

const restart = async (taskId: string, body: object = {}, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api/tasks/${taskId}/session/restart`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** The new session the restart opened, once it started. */
async function warmSession(before: FakeSession): Promise<FakeSession> {
  await vi.waitFor(() => {
    expect(sdk.fake.last).not.toBe(before)
  })
  return lastSession()
}

const setiNotes = async (taskId: string) =>
  (await messages.page(taskId, 100)).messages.flatMap((row) => (row.kind === 'seti' ? [row.payload] : []))

async function latestRestart() {
  await auditEvents.settled()
  return auditEvents.latest('task.session_restarted')
}

describe('restarting a session', () => {
  it('ends an idle process and opens a new one at once that resumes the same session', async () => {
    const id = await newTask()
    const first = await turn(id, 'first')
    const sessionId = (await tasks.get(id))?.session_id
    expect(sessionId).toMatch(/^new-/)

    const res = await restart(id)
    expect(res.status).toBe(200)
    expect(first.closed).toBe(true)
    const warm = await warmSession(first)
    expect(warm.options).toMatchObject({ resume: sessionId })
    expect(warm.prompts).toEqual([])
    expect(sessionState(id)).toEqual({ open: true, background: 0 })
    expect(await setiNotes(id)).toEqual([
      { error: 'Session restarted; the conversation continues', session: 'restarted' },
    ])
    expect((await latestRestart())?.detail).toMatchObject({ interrupted: false, fresh: false })

    expect(await turn(id, 'second')).toBe(warm)
    expect(warm.prompts[0]).toContain('The user restarted your Claude Code session from Seti')
    expect(warm.prompts[0]).toContain('second')
    expect((await tasks.get(id))?.session_id).toBe(sessionId)
    expect(await turn(id, 'third')).toBe(warm)
    expect(warm.prompts[1]).toBe('third')
  })

  it('ends background shells and subagents with the old process', async () => {
    const id = await newTask()
    const first = await turn(id, 'fan out')
    expect(sessionState(id)).toEqual({ open: true, background: 1 })
    expect((await restart(id)).status).toBe(200)
    expect(first.closed).toBe(true)
    await warmSession(first)
    expect(sessionState(id)).toEqual({ open: true, background: 0 })
  })

  it('refuses a running turn unless asked to stop it, then stops it and restarts', async () => {
    const id = await newTask()
    const first = await turn(id, 'first')
    await runTurn(id, 'hold on')
    await vi.waitFor(() => {
      expect(first.current).toBe('hold on')
    })
    const refused = await restart(id)
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('The agent is working')
    expect(first.closed).toBe(false)

    expect((await restart(id, { interrupt: true })).status).toBe(200)
    expect(sdk.fake.interrupted).toContain('hold on')
    expect(first.closed).toBe(true)
    expect((await tasks.get(id))?.status).toBe('stopped')
    const warm = await warmSession(first)
    expect(warm.options).toMatchObject({ resume: (await tasks.get(id))?.session_id })
    expect((await latestRestart())?.detail).toMatchObject({ interrupted: true, fresh: false })
  })

  it('starts a fresh session without the conversation when asked', async () => {
    const id = await newTask()
    const first = await turn(id, 'first')
    expect((await restart(id, { fresh: true })).status).toBe(200)
    const warm = await warmSession(first)
    expect(warm.options).not.toHaveProperty('resume')
    expect((await tasks.get(id))?.session_id).toBeNull()
    expect((await setiNotes(id)).at(-1)).toMatchObject({ session: 'fresh' })
    await turn(id, 'again')
    expect(warm.prompts[0]).toContain('fresh Claude Code session')
    expect((await latestRestart())?.detail).toMatchObject({ fresh: true })
  })

  it('reports how the new process connects its MCP servers', async () => {
    const id = await newTask()
    const first = await turn(id, 'first')
    const events: TaskEvent[] = []
    const stop = subscribe(id, (event) => {
      events.push(event)
    })
    sdk.fake.mcpStatus = [{ name: 'docs', status: 'connected' }]
    try {
      expect((await restart(id)).status).toBe(200)
      await warmSession(first)
      await vi.waitFor(async () => {
        expect((await sessionMcp(id))?.servers).toEqual([
          { name: 'docs', status: 'connected', error: null, transport: null },
        ])
      })
      expect(events).toContainEqual({ type: 'mcp' })
    } finally {
      stop()
      sdk.fake.mcpStatus = []
    }
  })

  it('names the EA as the actor when it asks', async () => {
    const id = await newTask()
    await turn(id, 'first')
    expect((await restart(id, {}, EA_AUTH)).status).toBe(200)
    expect((await latestRestart())?.detail).toMatchObject({ via: 'ea' })
  })

  it('refuses a bad body, an archived agent and an unknown one', async () => {
    const id = await newTask()
    await turn(id, 'first')
    expect((await restart(id, { interrupt: 'yes' })).status).toBe(400)
    await archiveTask(id, { actor: 'user', removeWorktree: false })
    expect((await restart(id)).status).toBe(409)
    expect(sessionState(id).open).toBe(false)
    expect((await restart('no-such-task')).status).toBe(404)
  })
})
