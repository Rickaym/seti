import type { Task } from '@seti/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { ASKING_REMINDER_MS, rearmAskingReminders, remindWhenAsking } from './asking-reminder.js'
import { sql, tasks } from './db.js'
import { resetAttention } from './ea-attention.js'
import { browser, decrypt, subscription, type Browser } from './fake-push.js'
import { fakeTimers } from './fake-timers.js'
import { notifyBody } from './notifications.js'
import { resetPresence } from './presence.js'
import { endSession, runTurn } from './runner.js'
import { pushDevices } from './store/notifications.js'
import { waitIdle } from './wait-idle.js'

const QUESTION = 'Should I open the PR now?'
const MINUTE = 60_000

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const fake = new FakeSdk(async function* ({ text }) {
    await Promise.resolve()
    yield fakeAssistant(text === 'question' ? 'The tests pass.\n\n**Should I open the PR now?**' : 'Done.')
    yield fakeResult()
  })
  return { query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

createApp()

let phone: Browser
let bodies: string[] = []
const created: string[] = []

beforeEach(async () => {
  bodies = []
  resetAttention()
  resetPresence()
  phone = browser()
  await pushDevices.put({ device_id: phone.id, ...subscription(phone), label: 'Phone' })
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    bodies.push(decrypt(phone, Buffer.from(init.body as Uint8Array)).body)
    return Promise.resolve(new Response(null, { status: 201 }))
  })
})

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await pushDevices.remove(phone.id)
  await sql`UPDATE task SET asking = false`
})

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

/** An agent whose turn just ended on a question, after the push about it went out. */
async function askingAgent(): Promise<Task> {
  const id = `reminder-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  await runTurn(id, 'question')
  await waitIdle(id)
  await vi.waitFor(() => {
    expect(bodies).toHaveLength(1)
  })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('task was not stored')
  }
  return task
}

/** Lets the work a fired timer started reach the database and the push service. */
const settle = async () => sql`SELECT pg_sleep(0.3)`

async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

const TIMERS = ['setTimeout', 'clearTimeout', 'Date'] as const

describe('the reminder of a question asked in a reply', () => {
  it('pushes the question when the turn ends, and exactly once more 15 minutes later', async () => {
    const task = await askingAgent()
    expect(task.asking).toBe(true)
    expect(bodies).toEqual([`Asks: ${QUESTION}`])
    expect(await notifyBody(task, 'needs_you')).toBe(`Asks: ${QUESTION}`)

    await fakeTimers([...TIMERS])
    await remindWhenAsking(task.id)
    await pass(ASKING_REMINDER_MS - MINUTE)
    expect(bodies).toHaveLength(1)
    await pass(MINUTE)
    expect(bodies).toEqual([`Asks: ${QUESTION}`, `Still waits: ${QUESTION}`])

    await pass(4 * ASKING_REMINDER_MS)
    await rearmAskingReminders()
    expect(vi.getTimerCount()).toBe(0)
    await pass(4 * ASKING_REMINDER_MS)
    expect(bodies).toHaveLength(2)
  })

  it('sends none once a message started another turn', async () => {
    const task = await askingAgent()
    await fakeTimers([...TIMERS])
    await remindWhenAsking(task.id)
    await tasks.setStatus(task.id, 'running', null)
    await pass(ASKING_REMINDER_MS)
    expect(bodies).toHaveLength(1)
  })

  it('drops the timer when the next turn ends without a question', async () => {
    const task = await askingAgent()
    await fakeTimers([...TIMERS])
    await remindWhenAsking(task.id)
    expect(vi.getTimerCount()).toBe(1)
    await tasks.endTurn(task.id, { status: 'idle', last_error: null, asking: false, closing_line: 'Done.' })
    await remindWhenAsking(task.id)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends none for a muted agent', async () => {
    const muted = await askingAgent()
    await tasks.setNotificationsMuted(muted.id, true)
    await fakeTimers([...TIMERS])
    await remindWhenAsking(muted.id)
    await pass(ASKING_REMINDER_MS)
    expect(bodies).toHaveLength(1)
  })

  it('after a restart reminds for the rest of the wait, and never for an older question', async () => {
    const task = await askingAgent()
    const ended = Date.parse(task.updated_at)
    await fakeTimers([...TIMERS])
    vi.setSystemTime(ended + 10 * MINUTE)
    await rearmAskingReminders()
    expect(vi.getTimerCount()).toBe(1)
    await pass(4 * MINUTE)
    expect(bodies).toHaveLength(1)
    await pass(MINUTE)
    expect(bodies).toEqual([`Asks: ${QUESTION}`, `Still waits: ${QUESTION}`])

    await rearmAskingReminders()
    expect(vi.getTimerCount()).toBe(0)
  })
})
