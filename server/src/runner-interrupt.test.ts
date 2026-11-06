import type { MessageRow, TaskStatus } from '@seti/shared'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { messages, tasks } from './db.js'
import { fakeTimers } from './fake-timers.js'
import { onTurnEnd, runTurn, subscribe } from './runner.js'
import { waitIdle } from './wait-idle.js'

/** Each turn says it is working, then waits to finish, be interrupted or be aborted. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const state = { active: 0, maxActive: 0, finish: new Map<string, () => void>() }
  const fake = new FakeSdk(async function* ({ text, signal }) {
    state.active++
    state.maxActive = Math.max(state.maxActive, state.active)
    try {
      yield fakeAssistant(`working on: ${text}`)
      const finished = await new Promise<boolean>((resolve) => {
        state.finish.set(text, () => {
          resolve(true)
        })
        signal.addEventListener('abort', () => {
          resolve(false)
        })
      })
      if (finished) {
        yield fakeAssistant(`answer to: ${text}`)
        yield fakeResult()
      }
    } finally {
      state.active--
    }
  })
  return { state, fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const turnEnds: [string, TaskStatus][] = []

beforeAll(() => {
  onTurnEnd((taskId, status) => {
    turnEnds.push([taskId, status])
  })
})

afterEach(() => {
  sdk.fake.interruptMode = 'honour'
  vi.useRealTimers()
})

let taskCount = 0

async function newTask(): Promise<{ id: string; statuses: TaskStatus[] }> {
  const id = `interrupt-task-${String(++taskCount)}`
  await tasks.insert({ id, title: 'Interrupt', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  const statuses: TaskStatus[] = []
  subscribe(id, (event) => {
    if (event.type === 'status') {
      statuses.push(event.status)
    }
  })
  return { id, statuses }
}

function label(row: MessageRow): string {
  if (row.kind === 'prompt') {
    return `prompt: ${row.payload.text}${row.payload.interrupted === true ? ' (interrupted)' : ''}`
  }
  if (row.kind !== 'sdk') {
    return row.kind
  }
  const { payload } = row
  if (payload.type === 'assistant') {
    return payload.message.content.map((block) => (block.type === 'text' ? block.text : block.type)).join(' ')
  }
  if (payload.type === 'result') {
    return `result: ${payload.subtype}`
  }
  return payload.type
}

const transcript = async (taskId: string) => (await messages.page(taskId, 100)).messages.map(label)
const endsOf = (taskId: string) => turnEnds.filter(([id]) => id === taskId).map(([, status]) => status)

async function working(taskId: string, prompt: string) {
  await vi.waitFor(async () => {
    expect(await transcript(taskId)).toContain(`working on: ${prompt}`)
  })
}

describe('interrupting a running turn with a new message', () => {
  it('ends the running query first, then answers the new message in order', async () => {
    const { id, statuses } = await newTask()
    await runTurn(id, 'refactor everything')
    await working(id, 'refactor everything')

    expect(await runTurn(id, 'stop and just say hi', { interrupt: true })).toBe('interrupted')
    expect((await tasks.get(id))?.status).toBe('running')
    await working(id, 'stop and just say hi')
    sdk.state.finish.get('stop and just say hi')?.()
    await waitIdle(id)
    expect((await tasks.get(id))?.status).toBe('idle')

    expect(sdk.fake.interrupted).toEqual(['refactor everything'])
    expect(sdk.state.maxActive).toBe(1)
    expect(sdk.fake.last?.prompts).toEqual(['refactor everything', 'stop and just say hi'])
    expect(sdk.fake.last?.closed).toBe(false)
    expect(await transcript(id)).toEqual([
      'prompt: refactor everything',
      'working on: refactor everything',
      'user',
      'result: error_during_execution',
      'prompt: stop and just say hi (interrupted)',
      'working on: stop and just say hi',
      'answer to: stop and just say hi',
      'result: success',
    ])
    expect(statuses).toEqual(['running', 'running', 'idle'])
    expect(endsOf(id)).toEqual(['idle'])
  })

  it('queues a message without the flag, and refuses slash commands even with it', async () => {
    const { id } = await newTask()
    await runTurn(id, 'long job')
    await working(id, 'long job')
    expect(await runTurn(id, 'hello')).toBe('queued')
    await expect(runTurn(id, '/compact', { interrupt: true })).rejects.toThrow('Slash commands wait')
    await expect(runTurn(id, '/compact')).rejects.toThrow('Slash commands wait')
    expect(sdk.fake.interrupted).not.toContain('long job')

    sdk.state.finish.get('long job')?.()
    await working(id, 'hello')
    expect((await tasks.get(id))?.status).toBe('running')
    sdk.state.finish.get('hello')?.()
    await waitIdle(id)
    expect((await tasks.get(id))?.status).toBe('idle')
    expect(endsOf(id)).toEqual(['idle'])
  })

  it('starts normally when the flag is set but nothing runs', async () => {
    const { id } = await newTask()
    expect(await runTurn(id, 'first', { interrupt: true })).toBe('started')
    await working(id, 'first')
    expect((await transcript(id))[0]).toBe('prompt: first')
    sdk.state.finish.get('first')?.()
    await vi.waitFor(() => {
      expect(endsOf(id)).toEqual(['idle'])
    })
  })

  it('aborts the query when it cannot be interrupted, without reporting an error', async () => {
    const { id } = await newTask()
    await runTurn(id, 'cannot interrupt')
    await working(id, 'cannot interrupt')
    sdk.fake.interruptMode = 'reject'
    await runTurn(id, 'take over', { interrupt: true })
    await working(id, 'take over')
    expect(sdk.fake.aborted).toContain('cannot interrupt')
    sdk.state.finish.get('take over')?.()
    await waitIdle(id)
    expect((await tasks.get(id))?.status).toBe('idle')
    expect(await transcript(id)).not.toContain('seti')
    expect(await transcript(id)).toContain('prompt: take over (interrupted)')
    expect(endsOf(id)).toEqual(['idle'])
  })

  it('aborts a query that ignores the interrupt once the grace period passes', async () => {
    const { id } = await newTask()
    await runTurn(id, 'stubborn')
    await working(id, 'stubborn')
    sdk.fake.interruptMode = 'ignore'
    await fakeTimers(['setTimeout', 'clearTimeout'])
    await runTurn(id, 'after grace', { interrupt: true })
    await vi.advanceTimersByTimeAsync(4000)
    expect(sdk.fake.aborted).not.toContain('stubborn')
    expect(sdk.fake.prompts).not.toContain('after grace')
    await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
    await working(id, 'after grace')
    expect(sdk.fake.aborted).toContain('stubborn')
    sdk.state.finish.get('after grace')?.()
    await vi.waitFor(() => {
      expect(endsOf(id)).toEqual(['idle'])
    })
  })

  it('drops a message that was itself replaced before its turn could start', async () => {
    const { id } = await newTask()
    await runTurn(id, 'original')
    await working(id, 'original')
    await runTurn(id, 'second thought', { interrupt: true })
    await runTurn(id, 'third thought', { interrupt: true })
    await working(id, 'third thought')
    sdk.state.finish.get('third thought')?.()
    await waitIdle(id)
    expect((await tasks.get(id))?.status).toBe('idle')
    expect(sdk.fake.prompts).not.toContain('second thought')
    expect((await transcript(id)).filter((line) => line.startsWith('prompt:'))).toEqual([
      'prompt: original',
      'prompt: third thought (interrupted)',
    ])
    expect(sdk.state.maxActive).toBe(1)
    expect(endsOf(id)).toEqual(['idle'])
  })
})
