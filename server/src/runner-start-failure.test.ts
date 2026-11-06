import type { MessageRow, PrInput, TaskStatus } from '@seti/shared'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { retryLastPrompt } from './dropped-prompt.js'
import { deliverInputs, wakeTask } from './inputs.js'
import { onTurnEnd, runTurn, sessionState } from './runner.js'
import type * as SessionOptions from './session-options.js'
import { restartSession } from './session-restart.js'
import { waitIdle } from './wait-idle.js'

const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const fake = new fakes.FakeSdk(function* ({ text }) {
    yield fakes.fakeAssistant(`answer to: ${text}`)
    yield fakes.fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

/** Tasks whose sessions cannot start, as when the sandbox cannot be set up, and their attempts. */
const starts = vi.hoisted(() => ({ refused: new Set<string>(), attempts: new Map<string, number>() }))

vi.mock('./session-options.js', async (importOriginal) => {
  const original = await importOriginal<typeof SessionOptions>()
  return {
    ...original,
    sessionStart: async (...args: Parameters<typeof original.sessionStart>) => {
      const [task] = args
      starts.attempts.set(task.id, (starts.attempts.get(task.id) ?? 0) + 1)
      if (starts.refused.has(task.id)) {
        throw new Error('bwrap: setting up uid map: Permission denied')
      }
      return original.sessionStart(...args)
    },
  }
})

createApp()
const turnEnds: [string, TaskStatus][] = []
let taskCount = 0

beforeAll(() => {
  onTurnEnd((taskId, status) => {
    turnEnds.push([taskId, status])
  })
})

async function refusedTask(): Promise<string> {
  const id = `start-failure-task-${String(++taskCount)}`
  await tasks.insert({ id, title: 'Start failure', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  starts.refused.add(id)
  return id
}

const rows = async (id: string): Promise<MessageRow[]> => (await messages.page(id, 500)).messages
const errors = async (id: string) =>
  (await rows(id)).flatMap((row) =>
    row.kind === 'seti' && row.payload.session === undefined ? [row.payload.error] : [],
  )
const promptTexts = async (id: string) =>
  (await rows(id)).flatMap((row) => (row.kind === 'prompt' ? [row.payload.text] : []))
const endsOf = (id: string) => turnEnds.filter(([taskId]) => taskId === id).map(([, status]) => status)

/** Waits for the lane to settle, then long enough that a retry loop would have run many times. */
async function settled(id: string): Promise<void> {
  await waitIdle(id)
  await new Promise((resolve) => setTimeout(resolve, 200))
  await waitIdle(id)
}

describe('a session that cannot start', () => {
  it('records one error, waits on the user and does not try again by itself', async () => {
    const id = await refusedTask()
    await runTurn(id, 'first')
    await settled(id)

    expect(starts.attempts.get(id)).toBe(1)
    expect(await errors(id)).toEqual(["Couldn't start: bwrap: setting up uid map: Permission denied"])
    expect(await promptTexts(id)).toEqual([])
    const task = await tasks.get(id)
    expect(task).toMatchObject({
      status: 'error',
      unseen: true,
      last_error: "Couldn't start: bwrap: setting up uid map: Permission denied",
    })
    expect(endsOf(id)).toEqual(['error'])
    expect(sessionState(id)).toEqual({ open: false, background: 0 })
  })

  it('sends the kept messages once, ahead of the next message, when a session starts', async () => {
    const id = await refusedTask()
    await runTurn(id, 'first')
    await settled(id)
    await runTurn(id, 'second')
    await settled(id)
    expect(starts.attempts.get(id)).toBe(2)
    expect(await errors(id)).toHaveLength(2)

    starts.refused.delete(id)
    await runTurn(id, 'third')
    await settled(id)
    expect(await promptTexts(id)).toEqual(['first', 'second', 'third'])
    expect((await tasks.get(id))?.status).toBe('idle')

    await runTurn(id, 'fourth')
    await settled(id)
    expect(await promptTexts(id)).toEqual(['first', 'second', 'third', 'fourth'])
    expect(await errors(id)).toHaveLength(2)
  })

  it('sends the kept messages when the user retries the turn', async () => {
    const id = await refusedTask()
    await runTurn(id, 'first')
    await settled(id)

    starts.refused.delete(id)
    expect(await retryLastPrompt(id)).toEqual({ prompt: 'first', outcome: 'started' })
    await settled(id)
    expect(await promptTexts(id)).toEqual(['first'])
    expect((await tasks.get(id))?.status).toBe('idle')
    expect(endsOf(id)).toEqual(['error', 'idle'])
  })

  it('sends the kept messages when the user restarts the session', async () => {
    const id = await refusedTask()
    await runTurn(id, 'first')
    await settled(id)

    starts.refused.delete(id)
    const task = await tasks.get(id)
    if (!task) {
      throw new Error('Task was not stored')
    }
    await restartSession(task, { interrupt: false, fresh: false })
    await settled(id)
    expect(await promptTexts(id)).toEqual(['first'])
    expect((await tasks.get(id))?.status).toBe('idle')
  })

  it('keeps updates from waking the agent again until the user acts', async () => {
    const id = await refusedTask()
    await tasks.setInputMode(id, 'wake')
    const update: PrInput = {
      source: 'pr',
      kind: 'ci_failed',
      subject: 'acme/web#7',
      title: 'CI failed on acme/web#7',
      body: '',
      url: 'https://github.com/acme/web/pull/7',
    }
    await deliverInputs(id, [update])
    // Stands in for the debounced wake, which fires a few seconds later.
    await wakeTask(id)
    await settled(id)

    expect(starts.attempts.get(id)).toBe(1)
    expect(await errors(id)).toHaveLength(1)
    expect(await wakeTask(id)).toBe(false)
    expect(starts.attempts.get(id)).toBe(1)

    starts.refused.delete(id)
    await runTurn(id, 'go on')
    await settled(id)
    expect(await promptTexts(id)).toEqual(['', 'go on'])
  })
})
