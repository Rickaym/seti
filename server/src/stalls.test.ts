import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { displayStatus, prStates, waitsOnYou, type PermissionRequest, type TaskEvent } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { noteSignedIn } from './mcp-session-status.js'
import { answerPermission } from './permission-rules.js'
import { endSession, liveSessions, runTurn, stopTurn } from './runner.js'
import { checkSilentSessions, SILENT_MS, silentReason } from './stall-watch.js'
import { refreshBlocked, setStall } from './task-blocked.js'
import { subscribe } from './task-events.js'
import { waitIdle } from './wait-idle.js'

/**
 * `hold` keeps working until stopped; `signin` asks for an MCP server's sign-in tool; `ask` asks
 * to run a command, then keeps working until stopped.
 */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const signIn = async (canUseTool: CanUseTool | undefined, signal: AbortSignal): Promise<PermissionResult | null> =>
    (await canUseTool?.('mcp__linear__authenticate', {}, { signal, toolUseID: 'toolu_1', requestId: 'req_1' })) ?? null
  const fake = new FakeSdk(async function* (turn) {
    if (turn.text === 'signin') {
      yield fakeAssistant(JSON.stringify(await signIn(turn.session.options.canUseTool, turn.signal)))
    } else if (turn.text === 'hold' || turn.text === 'ask') {
      if (turn.text === 'ask') {
        const options = { signal: turn.signal, toolUseID: 'toolu_2', requestId: 'req_2' }
        await turn.session.options.canUseTool?.('Bash', { command: 'make deploy' }, options)
      }
      await new Promise<void>((resolve) => {
        turn.signal.addEventListener('abort', () => {
          resolve()
        })
      })
    } else {
      yield fakeAssistant('Done.')
    }
    yield fakeResult()
  })
  return { query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

createApp()
const created: string[] = []

async function newTask(): Promise<string> {
  const id = `stall-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  return id
}

const blockedOf = async (id: string) => (await tasks.get(id))?.blocked ?? null

/** The task's next pending request, once its reason line is set and its views are told. */
const announced = async (id: string) =>
  new Promise<PermissionRequest>((resolve) => {
    const unsubscribe = subscribe(id, (event) => {
      if (event.type === 'permission' && event.request.state === 'pending') {
        unsubscribe()
        resolve(event.request)
      }
    })
  })

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('stalls', () => {
  it('make an agent wait on the user with their reason, and tell its views each change', async () => {
    const id = await newTask()
    const events: TaskEvent[] = []
    const unsubscribe = subscribe(id, (event) => events.push(event))
    await setStall(id, 'silent', 'No output for 20 min while running')
    const task = await tasks.get(id)
    expect(task?.blocked).toBe('No output for 20 min while running')
    expect(task !== undefined && waitsOnYou(task, displayStatus(task, prStates({}), 0))).toBe(true)
    await setStall(id, 'mcp', 'Sign in to the linear MCP server in Seti')
    expect(await blockedOf(id)).toBe('Sign in to the linear MCP server in Seti')
    await setStall(id, 'mcp', null)
    await setStall(id, 'silent', null)
    expect(await blockedOf(id)).toBeNull()
    expect(await refreshBlocked(id)).toBeNull()
    unsubscribe()
    expect(events.filter((event) => event.type === 'blocked').map((event) => event.blocked)).toEqual([
      'No output for 20 min while running',
      'Sign in to the linear MCP server in Seti',
      'No output for 20 min while running',
      null,
    ])
  })

  it('say when a running session went quiet, and why when the API keeps failing', () => {
    const quiet = { running: true, heardAt: 0, retrying: null }
    expect(silentReason(quiet, SILENT_MS - 1)).toBeNull()
    expect(silentReason(quiet, 25 * 60_000)).toBe('No output for 25 min while running')
    expect(silentReason({ ...quiet, retrying: 'rate_limit (429)' }, SILENT_MS)).toBe(
      'Claude API failing for 20 min: rate limit (429)',
    )
    expect(silentReason({ ...quiet, running: false }, 25 * 60_000)).toBeNull()
  })

  it('mark a running session that went quiet, and clear it once its turn ends', async () => {
    const id = await newTask()
    await runTurn(id, 'hold')
    await checkSilentSessions(Date.now() + SILENT_MS + 60_000)
    expect(await blockedOf(id)).toMatch(/^No output for 2\d min while running$/)
    await stopTurn(id)
    await checkSilentSessions()
    expect(await blockedOf(id)).toBeNull()
  })

  it('count no silence while a request waits, nor in the time it waited once answered', async () => {
    const id = await newTask()
    const events: TaskEvent[] = []
    const unsubscribe = subscribe(id, (event) => events.push(event))
    const asked = announced(id)
    await runTurn(id, 'ask')
    const request = await asked
    const session = liveSessions().find(([taskId]) => taskId === id)?.[1]
    if (session === undefined) {
      throw new Error('no open session')
    }
    const now = Date.now()
    session.heardAt = now - SILENT_MS - 60_000
    await checkSilentSessions(now)
    expect(await blockedOf(id)).toBe('Asks to use Bash: make deploy')
    const task = await tasks.get(id)
    if (task === undefined) {
      throw new Error('no task')
    }
    await answerPermission(task, request.id, { decision: 'allow' })
    expect(await blockedOf(id)).toBeNull()
    await checkSilentSessions()
    expect(await blockedOf(id)).toBeNull()
    await stopTurn(id)
    unsubscribe()
    const silent = events.filter((event) => event.type === 'blocked' && event.blocked?.startsWith('No output') === true)
    expect(silent).toEqual([])
  })

  it('turn an MCP sign-in the agent asks for into a reason the user sees, until a sign-in', async () => {
    const id = await newTask()
    await runTurn(id, 'signin')
    await waitIdle(id)
    expect(await blockedOf(id)).toBe('Sign in to the linear MCP server in Seti')
    noteSignedIn()
    await vi.waitFor(async () => {
      expect(await blockedOf(id)).toBeNull()
    })
  })

  it('drop an MCP sign-in reason when a new turn starts', async () => {
    const id = await newTask()
    await runTurn(id, 'signin')
    await waitIdle(id)
    await runTurn(id, 'again')
    await waitIdle(id)
    expect(await blockedOf(id)).toBeNull()
  })
})
