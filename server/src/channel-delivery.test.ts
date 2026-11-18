import fs from 'node:fs'
import {
  deliveryStep,
  type AgentState,
  type ChannelInput,
  type DeliveryStep,
  type DeliveryTiming,
  type InputMode,
  type PrInput,
  type PromptPayload,
} from '@seti/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { fakeTimers } from './fake-timers.js'
import { WAKE_DEBOUNCE, deliverInputs, releaseHeld } from './inputs.js'
import { isRunning } from './runner.js'
import { auditEvents } from './store/audit.js'
import { taskInputs } from './store/inputs.js'
import { refreshBlocked } from './task-blocked.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-delivery-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

/** A hanging turn waits for step(), which folds queued messages in, or finish(), which ends it. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  type Signal = 'step' | 'finish' | 'abort'
  const state = { prompts: [] as string[], hang: false, signal: (_: Signal): void => undefined }
  const fake = new FakeSdk(async function* ({ text, signal, fold }) {
    state.prompts.push(text)
    while (state.hang) {
      const next = await new Promise<Signal>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve('abort')
        })
        state.signal = resolve
      })
      if (next === 'abort') {
        return
      }
      if (next === 'finish') {
        break
      }
      state.prompts.push(...fold())
    }
    yield fakeResult()
  })
  return { state, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
let taskNumber = 0
let eventNumber = 0

function event(title: string, delivery?: DeliveryTiming): ChannelInput {
  eventNumber += 1
  return {
    source: 'channel',
    kind: 'deploy',
    channel: 'Deploys',
    channel_id: 'hook-deploys',
    event_id: eventNumber,
    severity: 'info',
    subject: 'ci',
    title,
    body: '',
    url: null,
    received_at: new Date().toISOString(),
    ...(delivery === undefined ? {} : { delivery }),
  }
}

const failing: PrInput = {
  source: 'pr',
  kind: 'ci_failed',
  subject: 'acme/web#7',
  title: 'CI failed on acme/web#7',
  body: '',
  url: null,
}

async function newTask(mode: InputMode = 'wake'): Promise<string> {
  taskNumber += 1
  const id = `delivery-task-${String(taskNumber)}`
  await tasks.insert({
    id,
    title: `Delivery ${String(taskNumber)}`,
    repo_id: null,
    cwd: scratch,
    worktree: false,
    pr_urls: [],
  })
  await tasks.setInputMode(id, mode)
  return id
}

const request = async (method: string, url: string, body?: unknown) =>
  app.request(`/api/tasks${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

const prompts = async (taskId: string): Promise<PromptPayload[]> =>
  (await messages.page(taskId, 100)).messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload] : []))

const waitingTitles = async (taskId: string) => (await taskInputs.pending(taskId, 20)).map((input) => input.title)

async function turnStarted(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(sdk.state.prompts).toHaveLength(count)
  })
}

/** Starts a turn that hangs until the test steps or finishes it. */
async function working(taskId: string): Promise<void> {
  sdk.state.hang = true
  expect((await request('POST', `/${taskId}/messages`, { prompt: 'work' })).status).toBe(200)
  await turnStarted(1)
}

async function finish(taskId: string): Promise<void> {
  sdk.state.hang = false
  sdk.state.signal('finish')
  await waitIdle(taskId)
}

/** Passes the quiet spell, so the debounced wake fires. */
const quiet = async () => vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE.quietMs)

beforeEach(async () => {
  sdk.state.prompts.length = 0
  sdk.state.hang = false
  await fakeTimers(['Date', 'setTimeout', 'clearTimeout'])
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the delivery decision', () => {
  const STATES: readonly AgentState[] = ['idle', 'running', 'blocked']
  const table: [InputMode, DeliveryTiming | null, [DeliveryStep, DeliveryStep, DeliveryStep]][] = [
    ['wake', 'now', ['start', 'join', 'after_answer']],
    ['wake', 'after_turn', ['start', 'after_turn', 'after_turn']],
    ['wake', 'with_message', ['hold', 'hold', 'hold']],
    ['wake', null, ['start', 'after_turn', 'after_turn']],
    ['queue', 'now', ['hold', 'hold', 'hold']],
    ['queue', 'after_turn', ['hold', 'hold', 'hold']],
    ['queue', 'with_message', ['hold', 'hold', 'hold']],
    ['queue', null, ['hold', 'hold', 'hold']],
    ['off', 'now', ['drop', 'drop', 'drop']],
    ['off', 'after_turn', ['drop', 'drop', 'drop']],
    ['off', 'with_message', ['drop', 'drop', 'drop']],
    ['off', null, ['drop', 'drop', 'drop']],
  ]

  it.each(table)('agent %s, subscription %s: idle, running, blocked', (mode, choice, steps) => {
    expect(STATES.map((state) => deliveryStep(mode, choice, state))).toEqual(steps)
  })
})

describe('Now', () => {
  it('starts a turn for an idle agent', async () => {
    const id = await newTask()
    expect(await deliverInputs(id, [event('Deploy failed', 'now')])).toEqual({
      outcome: 'delivered',
      reason: 'Handing to the agent in a few seconds',
    })
    await quiet()
    await waitIdle(id)
    expect(await prompts(id)).toEqual([{ text: '', auto: true, inputs: 1 }])
    expect(sdk.state.prompts[0]).toContain('Deploy failed')
  })

  it('joins a running turn at its next step, without ending or interrupting it', async () => {
    const id = await newTask()
    await working(id)
    expect(await deliverInputs(id, [event('Deploy failed', 'now')])).toEqual({
      outcome: 'delivered',
      reason: 'Joining the running turn in a few seconds',
    })
    await quiet()
    await vi.waitFor(async () => {
      expect(await prompts(id)).toEqual([{ text: 'work' }, { text: '', auto: true, inputs: 1, queued: 'waiting' }])
    })
    expect(sdk.state.prompts).toEqual(['work'])
    sdk.state.signal('step')
    await turnStarted(2)
    expect(sdk.state.prompts[1]).toContain('Deploy failed')
    expect(sdk.state.prompts[1]).toMatch(/they arrived while you were working\..*then carry on with your work\./)
    expect(isRunning(id)).toBe(true)
    await finish(id)
    expect(sdk.state.prompts).toHaveLength(2)
    expect((await prompts(id))[1]?.queued).toBe('delivered')
  })

  it('joins the turn even while earlier updates wait for its end', async () => {
    const id = await newTask()
    await working(id)
    await deliverInputs(id, [event('Routine', 'after_turn')])
    await quiet()
    await deliverInputs(id, [event('Urgent', 'now')])
    await quiet()
    await vi.waitFor(async () => {
      expect(await prompts(id)).toHaveLength(3)
    })
    sdk.state.signal('step')
    await turnStarted(2)
    expect(sdk.state.prompts[1]).toContain('Urgent')
    expect(sdk.state.prompts[1]).not.toContain('Routine')
    await finish(id)
    expect(sdk.state.prompts[2]).toContain('Routine')
  })

  it('waits while the agent is blocked on the user and joins the turn once the block clears', async () => {
    const id = await newTask()
    await working(id)
    await tasks.setBlocked(id, 'Asks a question: which region?')
    expect(await deliverInputs(id, [event('Deploy failed', 'now')])).toEqual({
      outcome: 'held',
      reason: 'The agent waits on the user; updates join its turn once the user answered',
    })
    await quiet()
    expect(await prompts(id)).toEqual([{ text: 'work' }])
    expect(await waitingTitles(id)).toEqual(['Deploy failed'])
    expect(await refreshBlocked(id)).toBeNull()
    await vi.waitFor(async () => {
      expect(await prompts(id)).toEqual([{ text: 'work' }, { text: '', auto: true, inputs: 1, queued: 'waiting' }])
    })
    sdk.state.signal('step')
    await turnStarted(2)
    expect(sdk.state.prompts[1]).toContain('Deploy failed')
    await finish(id)
  })

  it('delivers updates that arrive together as one batch', async () => {
    const id = await newTask()
    await deliverInputs(id, [event('First', 'now')])
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE.quietMs - 1000)
    await deliverInputs(id, [event('Second', 'now')])
    await deliverInputs(id, [event('Third')])
    await quiet()
    await waitIdle(id)
    expect(await prompts(id)).toEqual([{ text: '', auto: true, inputs: 3 }])
    expect(sdk.state.prompts[0]?.match(/<channel-event /g)).toHaveLength(3)
  })
})

describe('After turn', () => {
  it.each([['after_turn' as const], [undefined]])('waits for the running turn to end (%s)', async (delivery) => {
    const id = await newTask()
    await working(id)
    expect((await deliverInputs(id, [event('Deploy failed', delivery)])).outcome).toBe('delivered')
    await quiet()
    await vi.waitFor(async () => {
      expect(await prompts(id)).toHaveLength(2)
    })
    sdk.state.signal('step')
    await Promise.resolve()
    expect(sdk.state.prompts).toEqual(['work'])
    await finish(id)
    expect(sdk.state.prompts).toHaveLength(2)
    expect(sdk.state.prompts[1]).toMatch(/they arrived during your previous turn\./)
  })

  it('starts a turn at once for an idle agent', async () => {
    const id = await newTask()
    await deliverInputs(id, [event('Deploy failed', 'after_turn')])
    await quiet()
    await waitIdle(id)
    expect(await prompts(id)).toEqual([{ text: '', auto: true, inputs: 1 }])
  })
})

describe('With my message', () => {
  it('never starts a turn, outlasts automatic turns, and goes with the next message', async () => {
    const id = await newTask()
    expect(await deliverInputs(id, [event('Weekly digest', 'with_message')])).toEqual({
      outcome: 'queued',
      reason: "Held for the user's next message",
    })
    await quiet()
    expect(sdk.state.prompts).toEqual([])

    await deliverInputs(id, [failing])
    await quiet()
    await waitIdle(id)
    expect(await prompts(id)).toEqual([{ text: '', auto: true, inputs: 1 }])
    expect(sdk.state.prompts[0]).not.toContain('Weekly digest')
    expect(await waitingTitles(id)).toEqual(['Weekly digest'])

    expect((await request('POST', `/${id}/messages`, { prompt: 'morning' })).status).toBe(200)
    await waitIdle(id)
    expect(sdk.state.prompts[1]).toContain('Weekly digest')
    expect(sdk.state.prompts[1]?.endsWith('The message from the user follows.\n\nmorning')).toBe(true)
    expect(await waitingTitles(id)).toEqual([])
  })

  it('stays out of a running turn until the user hands it over', async () => {
    const id = await newTask()
    await working(id)
    await deliverInputs(id, [event('Weekly digest', 'with_message')])
    await quiet()
    sdk.state.signal('step')
    await finish(id)
    expect(sdk.state.prompts).toEqual(['work'])
    expect(await waitingTitles(id)).toEqual(['Weekly digest'])

    expect((await request('POST', `/${id}/inputs/deliver`)).status).toBe(200)
    await waitIdle(id)
    expect(await prompts(id)).toEqual([{ text: 'work' }, { text: '', auto: true, held: true, inputs: 1 }])
    expect(sdk.state.prompts[1]).toContain('Weekly digest')
    expect(await auditEvents.latest('task.inputs_delivered')).toMatchObject({ subject_id: id, detail: { count: 1 } })
  })

  it('joins the running turn when the user answers the agent', async () => {
    const id = await newTask()
    await working(id)
    await deliverInputs(id, [event('Weekly digest', 'with_message')])
    await releaseHeld(id)
    await vi.waitFor(async () => {
      expect(await prompts(id)).toEqual([
        { text: 'work' },
        { text: '', auto: true, held: true, inputs: 1, queued: 'waiting' },
      ])
    })
    sdk.state.signal('step')
    await turnStarted(2)
    expect(sdk.state.prompts[1]).toContain('Weekly digest')
    await finish(id)
    expect(await waitingTitles(id)).toEqual([])
  })

  it('can be dismissed while it waits', async () => {
    const id = await newTask()
    await deliverInputs(id, [event('Weekly digest', 'with_message')])
    await deliverInputs(id, [failing])
    await quiet()
    await waitIdle(id)
    const held = (await messages.page(id, 100)).messages.find((row) => row.kind === 'input')
    expect((await request('POST', `/${id}/inputs/dismiss`, { up_to: held?.id })).status).toBe(200)
    expect(await waitingTitles(id)).toEqual([])
  })
})

describe('the agent mode as a ceiling', () => {
  it('holds every delivery in a task that waits for the message', async () => {
    const id = await newTask('queue')
    expect(await deliverInputs(id, [event('Deploy failed', 'now')])).toEqual({
      outcome: 'queued',
      reason: 'The agent holds updates until the next message',
    })
    await quiet()
    expect(sdk.state.prompts).toEqual([])
    expect(await waitingTitles(id)).toEqual(['Deploy failed'])
  })

  it('keeps Now out of a running turn of a task that waits for the message', async () => {
    const id = await newTask('queue')
    await working(id)
    await deliverInputs(id, [event('Deploy failed', 'now')])
    await quiet()
    sdk.state.signal('step')
    await finish(id)
    expect(sdk.state.prompts).toEqual(['work'])
  })

  it('drops every delivery in a task that has updates off', async () => {
    const id = await newTask('off')
    expect((await deliverInputs(id, [event('Deploy failed', 'now')])).outcome).toBe('ignored')
    expect(await waitingTitles(id)).toEqual([])
  })
})
