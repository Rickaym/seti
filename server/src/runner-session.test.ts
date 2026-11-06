import type { PrInput, PromptPayload, TaskStatus } from '@seti/shared'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { OPENER_WAIT_MS, SESSION_IDLE_MS } from './config.js'
import { messages, tasks } from './db.js'
import { fakeAssistant, fakeBackground, fakeMessage, fakeResult, type FakeSession } from './fake-sdk.js'
import { fakeTimers } from './fake-timers.js'
import { deliverInputs, wakeTask } from './inputs.js'
import type * as McpSelection from './mcp-selection.js'
import { onTurnEnd, registerContextProvider, runTurn, sessionState, stopTurn } from './runner.js'
import { contextPacks, taskContextPacks } from './store/context.js'
import { rewinds } from './store/rewinds.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

/** Turns answer at once; `hold` turns run until interrupted, `fan out` leaves a subagent running. */
const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const init = { subtype: 'init', session_id: 'streamed', model: 'haiku', permissionMode: 'default' }
  const notice = () =>
    fakes.fakeMessage('result', {
      subtype: 'success',
      is_error: false,
      result: '',
      num_turns: 0,
      duration_ms: 0,
      total_cost_usd: 0,
      origin: { kind: 'task-notification' },
    })
  const fake = new fakes.FakeSdk(async function* ({ text, signal, session }) {
    yield fakes.fakeMessage('system', init)
    if (text.startsWith('notices first')) {
      session.emit(notice())
      session.emit(notice())
    }
    if (text.startsWith('dropped')) {
      session.emit(notice())
      await fakes.aborted(signal)
      return
    }
    if (text.startsWith('hold')) {
      await fakes.aborted(signal)
      return
    }
    if (text === 'think') {
      yield fakes.fakeMessage('system', {
        subtype: 'thinking_tokens',
        estimated_tokens: 40,
        estimated_tokens_delta: 40,
      })
    }
    if (text === 'fan out') {
      yield fakes.fakeBackground('subagent-1')
    }
    yield fakes.fakeAssistant(`answer to: ${text}`)
    yield fakes.fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

/** A task in `racing` gets the server `racing` turned off right after its first read. */
const denied = vi.hoisted(() => ({ racing: new Map<string, boolean>() }))

vi.mock('./mcp-selection.js', async (importOriginal) => {
  const original = await importOriginal<typeof McpSelection>()
  return {
    ...original,
    taskDeniedServers: async (taskId: string) => {
      const read = denied.racing.get(taskId)
      if (read === undefined) {
        return original.taskDeniedServers(taskId)
      }
      denied.racing.set(taskId, true)
      return read ? ['racing'] : []
    },
  }
})

const app = createApp()
const turnEnds: [string, TaskStatus][] = []
let taskCount = 0

beforeAll(() => {
  onTurnEnd((taskId, status) => {
    turnEnds.push([taskId, status])
  })
})

afterEach(() => {
  vi.useRealTimers()
})

async function newTask(): Promise<string> {
  const id = `session-task-${String(++taskCount)}`
  await tasks.insert({
    id,
    title: `Session ${String(taskCount)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
  })
  return id
}

const endsOf = (taskId: string) => turnEnds.filter(([id]) => id === taskId).map(([, status]) => status)
const prompts = async (taskId: string): Promise<PromptPayload[]> =>
  (await messages.page(taskId, 100)).messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload] : []))

function lastSession(): FakeSession {
  const last = sdk.fake.last
  if (!last) {
    throw new Error('No session started')
  }
  return last
}

const appendOf = ({ options }: FakeSession) =>
  typeof options.systemPrompt === 'object' && !Array.isArray(options.systemPrompt) && 'append' in options.systemPrompt
    ? (options.systemPrompt.append ?? '')
    : ''

const deniedOf = ({ options }: FakeSession) =>
  typeof options.settings === 'object' ? (options.settings.deniedMcpServers ?? []).map((d) => d.serverName) : null

async function settled(taskId: string): Promise<void> {
  await waitIdle(taskId)
  expect((await tasks.get(taskId))?.status).toBe('idle')
}

async function turn(taskId: string, prompt: string): Promise<FakeSession> {
  await runTurn(taskId, prompt)
  await settled(taskId)
  return lastSession()
}

const request = async (method: string, url: string) =>
  app.request(`/api/tasks${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
  })

describe('one streaming session per task', () => {
  it('keeps thinking token estimates out of the transcript', async () => {
    const id = await newTask()
    await turn(id, 'think')
    const rows = (await messages.page(id, 100)).messages
    expect(rows.some((row) => row.kind === 'sdk' && row.payload.type === 'assistant')).toBe(true)
    expect(rows.filter((row) => row.kind === 'sdk' && row.payload.type === 'system').map((row) => row.payload)).toEqual(
      [expect.objectContaining({ subtype: 'init' })],
    )
  })

  it('sends every message into the same session and reports each turn once', async () => {
    const id = await newTask()
    const session = await turn(id, 'first')
    expect(session.options).not.toHaveProperty('resume')
    expect(session.options).toMatchObject({ perTaskStopAffordance: true, enableFileCheckpointing: true })
    expect(await turn(id, 'second')).toBe(session)
    expect(session.prompts).toEqual(['first', 'second'])
    expect(await prompts(id)).toEqual([{ text: 'first' }, { text: 'second' }])
    expect(endsOf(id)).toEqual(['idle', 'idle'])
    expect(sessionState(id)).toEqual({ open: true, background: 0 })
  })

  it('keeps a background subagent running through the next message', async () => {
    const id = await newTask()
    const session = await turn(id, 'fan out')
    expect(sessionState(id)).toEqual({ open: true, background: 1 })
    expect(await turn(id, 'meanwhile')).toBe(session)
    expect(session.closed).toBe(false)
    expect(sdk.fake.aborted).not.toContain('fan out')

    session.emit(fakeBackground())
    session.emit(fakeMessage('system', { subtype: 'init', model: 'haiku', permissionMode: 'default' }))
    session.emit(fakeAssistant('the subagent reported back'))
    session.emit(fakeResult())
    await vi.waitFor(() => {
      expect(endsOf(id)).toEqual(['idle', 'idle', 'idle'])
    })
    expect(sessionState(id)).toEqual({ open: true, background: 0 })
  })

  it('stops a turn by interrupting it, leaving the session and its background work alone', async () => {
    const id = await newTask()
    const session = await turn(id, 'fan out')
    await runTurn(id, 'hold on')
    await vi.waitFor(() => {
      expect(session.current).toBe('hold on')
    })
    await stopTurn(id)
    expect((await tasks.get(id))?.status).toBe('stopped')
    expect(sdk.fake.interrupted).toContain('hold on')
    expect(session.closed).toBe(false)
    expect(sessionState(id)).toEqual({ open: true, background: 1 })
    expect(endsOf(id)).toEqual(['idle', 'stopped'])
    expect(await turn(id, 'after the stop')).toBe(session)
  })

  it('hands automatic turns for updates to the open session', async () => {
    const id = await newTask()
    await tasks.setInputMode(id, 'wake')
    const session = await turn(id, 'first')
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
    await vi.waitFor(() => {
      expect(session.prompts).toHaveLength(2)
    })
    await settled(id)
    expect(session.prompts[1]).toContain('<update source="pr" kind="ci_failed"')
    expect((await prompts(id)).at(-1)).toEqual({ text: '', auto: true, inputs: 1 })
    expect(sdk.fake.last).toBe(session)
  })

  it('closes an idle session after a while and resumes it on the next message', async () => {
    await fakeTimers(['setTimeout', 'clearTimeout'])
    const id = await newTask()
    const session = await turn(id, 'first')
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS - 1000)
    expect(session.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(session.closed).toBe(true)
    await vi.waitFor(() => {
      expect(sessionState(id).open).toBe(false)
    })
    expect((await tasks.get(id))?.status).toBe('idle')
    expect(endsOf(id)).toEqual(['idle'])

    const reopened = await turn(id, 'second')
    expect(reopened).not.toBe(session)
    expect(reopened.options).toMatchObject({ resume: 'streamed' })
  })

  it('keeps a session open while background work runs, however long it idles', async () => {
    await fakeTimers(['setTimeout', 'clearTimeout'])
    const id = await newTask()
    const session = await turn(id, 'fan out')
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS * 3)
    expect(session.closed).toBe(false)
    session.emit(fakeBackground())
    await vi.waitFor(() => {
      expect(sessionState(id).background).toBe(0)
    })
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS)
    expect(session.closed).toBe(true)
  })

  it('starts a new process for a pending rewind or changed context, once background work ended', async () => {
    const id = await newTask()
    const session = await turn(id, 'fan out')
    const pack = await contextPacks.create({ name: 'Session pack', description: '', body: 'Prefer small diffs.' })
    await taskContextPacks.set(id, [pack.id])
    expect(await turn(id, 'still here')).toBe(session)

    session.emit(fakeBackground())
    await vi.waitFor(() => {
      expect(sessionState(id).background).toBe(0)
    })
    const withPack = await turn(id, 'packed')
    expect(session.closed).toBe(true)
    expect(JSON.stringify(withPack.options.systemPrompt)).toContain('Prefer small diffs.')
    expect(withPack.options).toMatchObject({ resume: 'streamed' })

    const [first] = await prompts(id)
    await rewinds.insert({
      task_id: id,
      prompt_message_id: (await messages.page(id, 100)).messages.find((row) => row.kind === 'prompt')?.id ?? 0,
      last_message_id: 0,
      message_count: 1,
      prompt_text: first?.text ?? '',
      restore: 'conversation',
      state: 'pending',
      resume_at: 'kept-entry',
      drops_turn: null,
      files_changed: [],
    })
    const rewound = await turn(id, 'from the rewind')
    expect(withPack.closed).toBe(true)
    expect(rewound.options).toMatchObject({ resume: 'streamed', resumeSessionAt: 'kept-entry' })
    expect(await rewinds.pending(id)).toBeUndefined()
    expect(await turn(id, 'after it')).toBe(rewound)
  })

  it('starts the next turn without the role once it is unlinked', async () => {
    const id = await newTask()
    const role = await contextPacks.create({ name: 'Unlinked role', description: '', body: 'Own the release.' }, 'role')
    await taskContextPacks.setRole(id, role.id)
    const first = await turn(id, 'first')
    expect(appendOf(first)).toContain('## Your role\n')
    await taskContextPacks.setRole(id, null)
    const next = await turn(id, 'second')
    expect(next).not.toBe(first)
    expect(appendOf(next)).not.toContain('## Your role')
    expect(appendOf(next)).not.toContain('Own the release.')
  })

  it('leaves a role out of the next turn when it came and went while the session started', async () => {
    const id = await newTask()
    let context: string | null = null
    registerContextProvider((taskId) => {
      if (taskId !== id) {
        return null
      }
      const read = context
      context ??= '## Your role\nLinked while the session started.'
      return read
    })
    await turn(id, 'first')
    context = null
    expect(appendOf(await turn(id, 'second'))).not.toContain('## Your role')
  })

  it('restarts for an MCP server turned off while the session started, even once it is back', async () => {
    const id = await newTask()
    denied.racing.set(id, false)
    const first = await turn(id, 'first')
    expect(deniedOf(first)).toEqual(['racing'])
    denied.racing.delete(id)
    const next = await turn(id, 'second')
    expect(next).not.toBe(first)
    expect(deniedOf(next)).toEqual([])
  })

  it('ends the session with its background work when the task is deleted', async () => {
    const id = await newTask()
    const session = await turn(id, 'fan out')
    expect((await request('DELETE', `/${id}`)).status).toBe(204)
    expect(session.closed).toBe(true)
    expect(sessionState(id)).toEqual({ open: false, background: 0 })
  })

  it('keeps the turn running through notification turns Claude Code runs before the message', async () => {
    const id = await newTask()
    await turn(id, 'notices first')
    expect(endsOf(id)).toEqual(['idle'])
    const rows = (await messages.page(id, 100)).messages
    const results = rows.filter((row) => row.kind === 'sdk' && row.payload.type === 'result')
    expect(results).toHaveLength(3)
  })

  it('ends the turn when Claude Code goes quiet after a notification turn', async () => {
    await fakeTimers(['setTimeout', 'clearTimeout'])
    const id = await newTask()
    await runTurn(id, 'dropped after a notice')
    await vi.waitFor(async () => {
      const rows = (await messages.page(id, 100)).messages
      expect(rows.some((row) => row.kind === 'sdk' && row.payload.type === 'result')).toBe(true)
    })
    await vi.advanceTimersByTimeAsync(OPENER_WAIT_MS - 1000)
    expect((await tasks.get(id))?.status).toBe('running')
    await vi.advanceTimersByTimeAsync(1000)
    await settled(id)
    expect(endsOf(id)).toEqual(['idle'])
    expect((await request('POST', `/${id}/session/end`)).status).toBe(200)
  })

  it('stops all background work on request and marks a running turn stopped', async () => {
    const id = await newTask()
    const session = await turn(id, 'fan out')
    await runTurn(id, 'hold everything')
    await vi.waitFor(() => {
      expect(session.current).toBe('hold everything')
    })
    expect((await request('POST', `/${id}/session/end`)).status).toBe(200)
    expect(session.closed).toBe(true)
    expect(sdk.fake.aborted).toContain('hold everything')
    expect((await tasks.get(id))?.status).toBe('stopped')
    expect(endsOf(id)).toEqual(['idle', 'stopped'])
    expect(sessionState(id)).toEqual({ open: false, background: 0 })
    expect((await request('POST', `/${id}/session/end`)).status).toBe(409)
  })
})
