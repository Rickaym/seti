import type { MessageRow, PrInput, TaskStatus } from '@seti/shared'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { deliverInputs, wakeTask } from './inputs.js'
import { rewindTargets } from './rewind-task.js'
import { onTurnEnd, runTurn, stopTurn, subscribe } from './runner.js'
import { auditEvents } from './store/audit.js'
import { laneSettled } from './task-lane.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

type Step = 'fold' | 'finish'

/** Each turn works until told to take a tool round, which folds in queued messages, or to finish. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const state = { turns: [] as string[], steps: new Map<string, (step: Step) => void>() }
  const next = async (text: string, signal: AbortSignal) =>
    new Promise<Step | null>((resolve) => {
      state.steps.set(text, resolve)
      signal.addEventListener('abort', () => {
        resolve(null)
      })
    })
  const fake = new FakeSdk(async function* ({ text, signal, fold }) {
    state.turns.push(text)
    yield fakeAssistant(`working on: ${text}`)
    let taken = await next(text, signal)
    while (taken === 'fold') {
      for (const folded of fold()) {
        yield fakeAssistant(`also: ${folded}`)
      }
      taken = await next(text, signal)
    }
    if (taken === 'finish') {
      yield fakeAssistant(`answer to: ${text}`)
      yield fakeResult()
    }
  })
  return { state, fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const turnEnds: [string, TaskStatus][] = []

beforeAll(() => {
  onTurnEnd((taskId, status) => {
    turnEnds.push([taskId, status])
  })
})

afterEach(() => {
  sdk.fake.cancels = true
})

let taskCount = 0

async function newTask(): Promise<{ id: string; statuses: TaskStatus[]; updated: MessageRow[] }> {
  const id = `queue-task-${String(++taskCount)}`
  await tasks.insert({
    id,
    title: `Queue ${String(taskCount)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
  })
  const statuses: TaskStatus[] = []
  const updated: MessageRow[] = []
  subscribe(id, (event) => {
    if (event.type === 'status') {
      statuses.push(event.status)
    } else if (event.type === 'updated') {
      updated.push(event.row)
    }
  })
  return { id, statuses, updated }
}

const request = async (method: string, url: string, body?: unknown) =>
  app.request(`/api/tasks${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

function label(row: MessageRow): string {
  if (row.kind === 'prompt') {
    const { text, queued, interrupted } = row.payload
    const notes = [queued, interrupted === true ? 'interrupted' : undefined].filter((note) => note !== undefined)
    return ['prompt:', text, ...notes.map((note) => `(${note})`)].join(' ')
  }
  if (row.kind !== 'sdk') {
    return row.kind
  }
  const { payload } = row
  if (payload.type === 'assistant') {
    return payload.message.content.map((block) => (block.type === 'text' ? block.text : block.type)).join(' ')
  }
  return payload.type === 'result' ? `result: ${payload.subtype}` : payload.type
}

const transcript = async (taskId: string) => (await messages.page(taskId, 100)).messages.map(label)
const prompts = async (taskId: string) => (await transcript(taskId)).filter((line) => line.startsWith('prompt: '))
const endsOf = (taskId: string) => turnEnds.filter(([id]) => id === taskId).map(([, status]) => status)
const promptId = async (taskId: string, text: string) =>
  (await messages.page(taskId, 100)).messages.find((row) => row.kind === 'prompt' && row.payload.text === text)?.id ?? 0

async function working(taskId: string, text: string) {
  await vi.waitFor(async () => {
    expect(await transcript(taskId)).toContain(`working on: ${text}`)
  })
}

function step(text: string, next: Step) {
  const resolve = sdk.state.steps.get(text)
  sdk.state.steps.delete(text)
  resolve?.(next)
}

async function queuedState(taskId: string, text: string, state: string) {
  await vi.waitFor(async () => {
    expect(await prompts(taskId)).toContain(`prompt: ${text} (${state})`)
  })
  await laneSettled(taskId)
}

describe('messages sent while a turn runs', () => {
  it('queue for the agent, which reads them at the next tool round of the same turn', async () => {
    const { id, statuses, updated } = await newTask()
    await runTurn(id, 'build it')
    await working(id, 'build it')

    const sent = await request('POST', `/${id}/messages`, { prompt: 'also say blue' })
    expect(sent.status).toBe(200)
    expect(await prompts(id)).toEqual(['prompt: build it', 'prompt: also say blue (waiting)'])
    expect((await tasks.get(id))?.status).toBe('running')
    expect(await auditEvents.latest('task.message_sent')).toMatchObject({
      subject_id: id,
      summary: `Queued a message for the running turn of task "Queue ${String(taskCount)}"`,
      detail: { prompt: 'also say blue', queued: true },
    })

    step('build it', 'fold')
    await queuedState(id, 'also say blue', 'delivered')
    expect(updated.map(label)).toEqual(['prompt: also say blue (delivered)'])
    step('build it', 'finish')
    await waitIdle(id)

    expect(await transcript(id)).toEqual([
      'prompt: build it',
      'working on: build it',
      'prompt: also say blue (delivered)',
      'also: also say blue',
      'answer to: build it',
      'result: success',
    ])
    expect(sdk.state.turns.filter((turn) => turn.includes('blue'))).toEqual([])
    expect(sdk.fake.interrupted).toEqual([])
    expect(statuses.filter((status) => status !== 'running')).toEqual(['idle'])
    await vi.waitFor(
      () => {
        expect(endsOf(id)).toEqual(['idle'])
      },
      { timeout: 10_000 },
    )
    expect((await rewindTargets(id)).map((target) => target.text)).toEqual(['build it'])
  })

  it('keep their order, and those left at the end of a turn run next without an end between', async () => {
    const { id, statuses } = await newTask()
    await runTurn(id, 'first')
    await working(id, 'first')
    expect(await runTurn(id, 'second')).toBe('queued')
    expect(await runTurn(id, 'third')).toBe('queued')
    await vi.waitFor(() => {
      expect(sdk.fake.last?.prompts).toEqual(['first', 'second', 'third'])
    })

    step('first', 'finish')
    await working(id, 'second\n\nthird')
    expect(await prompts(id)).toEqual(['prompt: first', 'prompt: second (delivered)', 'prompt: third (delivered)'])
    expect((await tasks.get(id))?.status).toBe('running')
    expect(endsOf(id)).toEqual([])
    step('second\n\nthird', 'finish')
    await waitIdle(id)

    expect(statuses.filter((status) => status !== 'running')).toEqual(['idle'])
    await vi.waitFor(
      () => {
        expect(endsOf(id)).toEqual(['idle'])
      },
      { timeout: 10_000 },
    )
    expect((await transcript(id)).filter((line) => line.startsWith('result'))).toEqual([
      'result: success',
      'result: success',
    ])
  })

  it('can be taken back before the agent reads them, and not after', async () => {
    const { id } = await newTask()
    await runTurn(id, 'long job')
    await working(id, 'long job')
    await runTurn(id, 'never mind')
    await runTurn(id, 'keep this')
    const removed = await request('DELETE', `/${id}/queue/${String(await promptId(id, 'never mind'))}`)
    expect(removed.status).toBe(200)
    expect(await auditEvents.latest('task.queued_message_removed')).toMatchObject({
      subject_id: id,
      detail: { prompt: 'never mind' },
    })
    const again = await request('DELETE', `/${id}/queue/${String(await promptId(id, 'never mind'))}`)
    expect(again.status).toBe(409)

    step('long job', 'fold')
    await queuedState(id, 'keep this', 'delivered')
    const late = await request('DELETE', `/${id}/queue/${String(await promptId(id, 'keep this'))}`)
    expect(late.status).toBe(409)
    step('long job', 'finish')
    await waitIdle(id)

    expect(await prompts(id)).toEqual([
      'prompt: long job',
      'prompt: never mind (removed)',
      'prompt: keep this (delivered)',
    ])
    expect(await transcript(id)).not.toContain('also: never mind')
    await vi.waitFor(
      () => {
        expect(endsOf(id)).toEqual(['idle'])
      },
      { timeout: 10_000 },
    )
  })

  it('stay queued when the SDK cannot take a message back', async () => {
    const { id } = await newTask()
    sdk.fake.cancels = false
    await runTurn(id, 'no cancel')
    await working(id, 'no cancel')
    await runTurn(id, 'stuck')
    const removed = await request('DELETE', `/${id}/queue/${String(await promptId(id, 'stuck'))}`)
    expect(removed.status).toBe(409)
    expect(await removed.text()).toContain('cannot take back a queued message')
    step('no cancel', 'fold')
    await vi.waitFor(async () => {
      expect(await transcript(id)).toContain('also: stuck')
    })
    step('no cancel', 'finish')
    await waitIdle(id)
    expect(await prompts(id)).toEqual(['prompt: no cancel', 'prompt: stuck (delivered)'])
  })

  it('are taken back when the user stops the turn, which ends once as stopped', async () => {
    const { id } = await newTask()
    await runTurn(id, 'stop me')
    await working(id, 'stop me')
    await runTurn(id, 'later')
    await stopTurn(id)
    await waitIdle(id)

    expect((await tasks.get(id))?.status).toBe('stopped')
    expect(await prompts(id)).toEqual(['prompt: stop me', 'prompt: later (removed)'])
    expect(sdk.state.turns.filter((turn) => turn.includes('later'))).toEqual([])
    await vi.waitFor(
      () => {
        expect(endsOf(id)).toEqual(['stopped'])
      },
      { timeout: 10_000 },
    )
  })

  it('go to the agent at once when the user stops the turn to deliver them, updates aside', async () => {
    const { id } = await newTask()
    await runTurn(id, 'long job')
    await working(id, 'long job')
    await deliverInputs(id, [
      {
        source: 'pr',
        kind: 'review',
        subject: 'acme/web#10',
        title: 'Changes requested on acme/web#10',
        body: 'Rename it.',
        url: 'https://github.com/acme/web/pull/10',
      },
    ])
    // Stands in for the debounced wake, which fires a few seconds later.
    await wakeTask(id)
    expect(await runTurn(id, 'look at this first')).toBe('queued')
    const stopped = await request('POST', `/${id}/stop?queued=deliver`)
    expect(stopped.status).toBe(200)
    await working(id, 'look at this first')

    expect(sdk.fake.interrupted).toContain('long job')
    expect((await tasks.get(id))?.status).toBe('running')
    step('look at this first', 'finish')
    await waitIdle(id)
    expect(await prompts(id)).toEqual([
      'prompt: long job',
      'prompt:  (removed)',
      'prompt: look at this first (delivered)',
    ])
    expect(sdk.state.turns.slice(-2)).toEqual(['long job', 'look at this first'])
    await vi.waitFor(
      () => {
        expect(endsOf(id)).toEqual(['idle'])
      },
      { timeout: 10_000 },
    )
  })

  it('are taken back by a stop that does not ask to deliver them', async () => {
    const { id } = await newTask()
    await runTurn(id, 'plain stop')
    await working(id, 'plain stop')
    await runTurn(id, 'dropped')
    expect((await request('POST', `/${id}/stop`)).status).toBe(200)
    await waitIdle(id)
    expect(await prompts(id)).toEqual(['prompt: plain stop', 'prompt: dropped (removed)'])
    expect((await tasks.get(id))?.status).toBe('stopped')
  })

  it('are taken back by a message that interrupts the turn, which goes out after it', async () => {
    const { id } = await newTask()
    await runTurn(id, 'old plan')
    await working(id, 'old plan')
    await runTurn(id, 'queued idea')
    expect(await runTurn(id, 'new plan', { interrupt: true })).toBe('interrupted')
    expect(await runTurn(id, 'after the new plan')).toBe('queued')
    await working(id, 'new plan')
    step('new plan', 'fold')
    await vi.waitFor(async () => {
      expect(await transcript(id)).toContain('also: after the new plan')
    })
    step('new plan', 'finish')
    await waitIdle(id)

    expect(sdk.fake.interrupted).toContain('old plan')
    expect(await prompts(id)).toEqual([
      'prompt: old plan',
      'prompt: queued idea (removed)',
      'prompt: new plan (interrupted)',
      'prompt: after the new plan (delivered)',
    ])
    await vi.waitFor(
      () => {
        expect(endsOf(id)).toEqual(['idle'])
      },
      { timeout: 10_000 },
    )
  })

  it('let a user message join the turn while updates wait for it to end and start their own', async () => {
    const { id, statuses } = await newTask()
    const review: PrInput = {
      source: 'pr',
      kind: 'review',
      subject: 'acme/web#9',
      title: 'Changes requested on acme/web#9',
      body: 'Rename the helper.',
      url: 'https://github.com/acme/web/pull/9',
    }
    await runTurn(id, 'multi step')
    await working(id, 'multi step')
    await deliverInputs(id, [review])
    // Stands in for the debounced wake, which fires a few seconds later.
    await wakeTask(id)
    expect(await runTurn(id, 'note from the user')).toBe('queued')
    await vi.waitFor(() => {
      expect(sdk.fake.last?.priorities).toEqual([undefined, 'later', undefined])
    })
    const update = sdk.fake.last?.prompts[1] ?? ''
    expect(update).toContain('Changes requested on acme/web#9')

    step('multi step', 'fold')
    await queuedState(id, 'note from the user', 'delivered')
    await vi.waitFor(async () => {
      expect(await transcript(id)).toContain('also: note from the user')
    })
    expect(await transcript(id)).not.toContain(`also: ${update}`)
    expect(await prompts(id)).toContain('prompt:  (waiting)')

    step('multi step', 'finish')
    await working(id, update)
    expect(await prompts(id)).toContain('prompt:  (delivered)')
    expect(endsOf(id)).toEqual([])
    step(update, 'finish')
    await waitIdle(id)

    expect(sdk.state.turns.slice(-2)).toEqual(['multi step', update])
    expect((await transcript(id)).filter((line) => line.startsWith('result'))).toEqual([
      'result: success',
      'result: success',
    ])
    expect(sdk.fake.interrupted).not.toContain('multi step')
    expect(statuses.filter((status) => status !== 'running')).toEqual(['idle'])
    await vi.waitFor(
      () => {
        expect(endsOf(id)).toEqual(['idle'])
      },
      { timeout: 10_000 },
    )
  })

  it('refuse slash commands, which wait until the turn ends', async () => {
    const { id } = await newTask()
    await runTurn(id, 'busy')
    await working(id, 'busy')
    const refused = await request('POST', `/${id}/messages`, { prompt: '/compact' })
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('Slash commands wait until the agent finishes its turn')
    step('busy', 'finish')
    await waitIdle(id)
  })
})
