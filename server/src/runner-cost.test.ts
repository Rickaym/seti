import { turnCostOf } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { messages, tasks } from './db.js'
import type { FakeSession } from './fake-sdk.js'
import { endSession, runTurn, stopTurn } from './runner.js'
import { restartSession } from './session-restart.js'
import { waitIdle } from './wait-idle.js'

/**
 * Claude Code's cost ledger: each result carries the session's running total, a resumed process
 * starts from the total the transcript saved, and a turn's text says what it spends.
 */
const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const ledger = {
    saved: new Map<string, number>(),
    running: new Map<object, { id: string; total: number }>(),
    sessions: 0,
    /** Off while a process would die before its transcript saves the total. */
    saving: true,
  }
  const spend = (session: object, usd: number) => {
    const state = ledger.running.get(session)
    if (state !== undefined) {
      state.total += usd
      if (ledger.saving) {
        ledger.saved.set(state.id, state.total)
      }
    }
  }
  const stateOf = (session: FakeSession) => {
    const found = ledger.running.get(session)
    if (found !== undefined) {
      return found
    }
    const resume = session.options.resume
    const id = resume ?? `cost-session-${String(++ledger.sessions)}`
    const state = { id, total: resume === undefined ? 0 : (ledger.saved.get(resume) ?? 0) }
    ledger.running.set(session, state)
    return state
  }
  const result = (state: { id: string; total: number }, failed = false) =>
    fakes.fakeMessage('result', {
      session_id: state.id,
      subtype: failed ? 'error_during_execution' : 'success',
      is_error: failed,
      result: 'done',
      errors: [],
      total_cost_usd: state.total,
      duration_ms: 1,
      num_turns: 1,
    })
  const fake = new fakes.FakeSdk(async function* ({ text, signal, session }) {
    const state = stateOf(session)
    const [verb, amount] = text.split(' ')
    yield fakes.fakeMessage('system', {
      subtype: 'init',
      session_id: state.id,
      model: 'haiku',
      permissionMode: 'default',
    })
    spend(session, Number(amount ?? 0))
    if (verb === 'hold') {
      await fakes.aborted(signal)
      yield result(state, true)
      return
    }
    yield fakes.fakeAssistant(`spent ${amount ?? '0'}`)
    yield result(state, verb === 'fail')
  })
  return { fake, query: fake.query, ledger, spend, result, stateOf }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

let taskCount = 0

async function newTask(): Promise<string> {
  const id = `cost-task-${String(++taskCount)}`
  await tasks.insert({
    id,
    title: `Cost ${String(taskCount)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
  })
  return id
}

async function turn(taskId: string, prompt: string): Promise<FakeSession> {
  await runTurn(taskId, prompt)
  await waitIdle(taskId)
  const last = sdk.fake.last
  if (last === undefined) {
    throw new Error('No session started')
  }
  return last
}

const costOf = async (taskId: string) => (await tasks.get(taskId))?.cost_usd ?? Number.NaN

async function turnCosts(taskId: string): Promise<(number | null)[]> {
  const rows = (await messages.page(taskId, 200)).messages
  return rows.flatMap((row) => (row.kind === 'sdk' && row.payload.type === 'result' ? [turnCostOf(row.payload)] : []))
}

describe('the cost of an agent', () => {
  it('adds what each turn spent, not the running total each result carries', async () => {
    const id = await newTask()
    await turn(id, 'spend 0.25')
    await turn(id, 'spend 0.5')
    await turn(id, 'spend 1')
    expect(await costOf(id)).toBeCloseTo(1.75)
    expect(await turnCosts(id)).toEqual([0.25, 0.5, 1])
  })

  it('counts a resumed session from the total its transcript restored', async () => {
    const id = await newTask()
    const first = await turn(id, 'spend 0.5')
    await endSession(id)
    const resumed = await turn(id, 'spend 0.25')
    expect(resumed).not.toBe(first)
    expect(resumed.options.resume).toBe(sdk.stateOf(first).id)
    await turn(id, 'spend 0.125')
    expect(await costOf(id)).toBeCloseTo(0.875)
  })

  it('never counts more than was spent when the restored total is older than the last result', async () => {
    const id = await newTask()
    await turn(id, 'spend 0.5')
    sdk.ledger.saving = false
    await turn(id, 'spend 0.25')
    await endSession(id)
    sdk.ledger.saving = true
    await turn(id, 'spend 0.125')
    await turn(id, 'spend 0.0625')
    const cost = await costOf(id)
    expect(cost).toBeLessThanOrEqual(0.9375)
    expect(cost).toBeCloseTo(0.8125)
    expect(await turnCosts(id)).toEqual([0.5, 0.25, null, 0.0625])
  })

  it('counts a fresh session from zero on top of what the agent spent before', async () => {
    const id = await newTask()
    await turn(id, 'spend 0.5')
    const task = await tasks.get(id)
    if (task === undefined) {
      throw new Error('task missing')
    }
    await restartSession(task, { interrupt: false, fresh: true })
    const fresh = await turn(id, 'spend 0.25')
    expect(fresh.options.resume).toBeUndefined()
    await turn(id, 'spend 0.25')
    expect(await costOf(id)).toBeCloseTo(1)
  })

  it('counts what background subagents spent after a result with the next one', async () => {
    const id = await newTask()
    const session = await turn(id, 'spend 0.5')
    sdk.spend(session, 0.75)
    session.emit(sdk.result(sdk.stateOf(session)))
    await vi.waitFor(async () => {
      expect(await turnCosts(id)).toHaveLength(2)
    })
    await waitIdle(id)
    await turn(id, 'spend 0.25')
    expect(await costOf(id)).toBeCloseTo(1.5)
    expect(await turnCosts(id)).toEqual([0.5, 0.75, 0.25])
  })

  it('counts an interrupted turn and a failed one', async () => {
    const id = await newTask()
    const session = await turn(id, 'spend 0.5')
    await runTurn(id, 'hold 0.25')
    await vi.waitFor(() => {
      expect(session.current).toBe('hold 0.25')
    })
    await stopTurn(id)
    await turn(id, 'fail 0.125')
    expect(await costOf(id)).toBeCloseTo(0.875)
    expect(await turnCosts(id)).toEqual([0.5, 0.25, 0.125])
  })
})
