import { randomUUID } from 'node:crypto'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import {
  timedOutMessage,
  type AgentPermissions,
  type PermissionPolicy,
  type PermissionRequest,
  type PermissionTimeoutSettings,
  type Task,
} from '@seti/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { messages, tasks } from './db.js'
import { resumePermissionTimeouts, setPermissionTimeout } from './permission-timeout.js'
import { endSession, runTurn } from './runner.js'
import { auditEvents } from './store/audit.js'
import { permissionRequests, timeoutSettings } from './store/permissions.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

/** Asks to run the command its prompt names and replies with the answer Seti gave. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const ask = async (canUseTool: CanUseTool, command: string, signal: AbortSignal): Promise<PermissionResult | null> =>
    canUseTool(
      'Bash',
      { command },
      {
        signal,
        toolUseID: 'toolu_1',
        requestId: 'req_1',
        decisionReason: 'Not allowed',
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'localSettings',
            rules: [{ toolName: 'Bash', ruleContent: `${command}:*` }],
          },
        ],
      },
    )
  const fake = new FakeSdk(async function* (turn) {
    const { canUseTool } = turn.session.options
    const result = canUseTool === undefined ? null : await ask(canUseTool, turn.text, turn.signal)
    yield fakeAssistant(JSON.stringify(result))
    yield fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const MINUTE = 60_000
const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const created: string[] = []

async function newTask(): Promise<Task> {
  const id = `timeout-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

async function call<T>(method: string, path: string, body?: unknown, auth: object = headers): Promise<T> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...headers, ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as { data: T; error?: { detail: string } }
  if (res.status !== 200) {
    throw new Error(`${String(res.status)} ${json.error?.detail ?? ''}`)
  }
  return json.data
}

const requestsOf = async (taskId: string) => call<PermissionRequest[]>('GET', `/tasks/${taskId}/permission-requests`)

/** Starts a turn that asks to run the command, and returns the request once the agent waits on it. */
async function raise(taskId: string, command: string): Promise<PermissionRequest> {
  await runTurn(taskId, command)
  return vi.waitFor(
    async () => {
      const request = (await requestsOf(taskId)).find((r) => r.state === 'pending')
      if (request === undefined) {
        throw new Error('No request waits yet')
      }
      return request
    },
    { interval: 10 },
  )
}

async function stateOf(taskId: string, state: PermissionRequest['state']): Promise<PermissionRequest> {
  return vi.waitFor(
    async () => {
      const request = (await requestsOf(taskId)).at(-1)
      if (request?.state !== state) {
        throw new Error(`The request is ${request?.state ?? 'missing'}, not ${state}`)
      }
      return request
    },
    { interval: 10 },
  )
}

async function reply(taskId: string): Promise<{ behavior: string; message?: string }> {
  await waitIdle(taskId)
  const rows = (await messages.page(taskId, 50)).messages
  const texts = rows.flatMap((row) =>
    row.kind === 'sdk' && row.payload.type === 'assistant' ? row.payload.message.content : [],
  )
  const last = texts.at(-1)
  return JSON.parse(last?.type === 'text' ? last.text : '{}') as { behavior: string; message?: string }
}

const timedOutAudits = async (taskId: string) => {
  await auditEvents.settled()
  const latest = await auditEvents.latest('task.permission_timed_out')
  return latest?.subject_id === taskId ? latest : undefined
}

const rulesOf = async (taskId: string) => [
  ...(await call<AgentPermissions>('GET', `/tasks/${taskId}/permissions`)).own,
  ...(await call<PermissionPolicy>('GET', '/permissions')).rules,
]

/** Loses every timer as a restart does, keeping the time, then arms from the database again. */
async function restart(downForMs = 0): Promise<void> {
  const at = Date.now()
  vi.clearAllTimers()
  vi.setSystemTime(at + downForMs)
  await resumePermissionTimeouts()
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await timeoutSettings.set(60)
})

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('permission request timeout', () => {
  it('denies an unanswered request at the timeout, tells the agent why and keeps no rule', async () => {
    const task = await newTask()
    const request = await raise(task.id, 'make deploy')
    expect(Date.parse(request.timeout_at ?? '') - Date.parse(request.created_at)).toBe(60 * MINUTE)

    await vi.advanceTimersByTimeAsync(47 * MINUTE)
    await vi.waitFor(async () => {
      expect((await tasks.get(task.id))?.blocked).toBe('Asks to use Bash: make deploy')
    })
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    await vi.waitFor(async () => {
      expect((await tasks.get(task.id))?.blocked).toBe('Asks to use Bash: make deploy, times out soon')
    })
    expect((await requestsOf(task.id)).at(-1)?.state).toBe('pending')

    await vi.advanceTimersByTimeAsync(12 * MINUTE)
    const denied = await stateOf(task.id, 'denied')
    expect(denied).toMatchObject({ id: request.id, timed_out: true, message: null })
    expect(await reply(task.id)).toEqual({ behavior: 'deny', message: timedOutMessage(60) })
    expect(timedOutMessage(60)).toBe(
      'No answer within 1 h, so Seti denied this automatically; this is not a judgement on the action. ' +
        'Carry on without it if you can, or ask again when it is needed.',
    )
    expect(await rulesOf(task.id)).toEqual([])
    expect((await tasks.get(task.id))?.blocked).toBeNull()

    expect(await timedOutAudits(task.id)).toMatchObject({
      actor: 'system',
      summary: `Denied Bash for task "${task.title}": no answer within 1 h`,
      detail: { tool: 'Bash', call: 'make deploy', rules: ['Bash(make deploy:*)'], timeout_minutes: 60 },
    })
    const notes = (await messages.page(task.id, 50)).messages.flatMap((row) => (row.kind === 'seti' ? [row] : []))
    expect(notes.at(-1)?.payload).toEqual({
      error: 'Denied Bash: timed out after 1 h with no answer',
      timed_out: denied.decided_at,
    })
  })

  it('never denies while the timeout is off', async () => {
    await call('PUT', '/permissions/timeout', { request_timeout_minutes: 0 })
    const task = await newTask()
    const request = await raise(task.id, 'make release')
    expect(request.timeout_at).toBeNull()
    await vi.advanceTimersByTimeAsync(48 * 60 * MINUTE)
    expect((await requestsOf(task.id)).at(-1)?.state).toBe('pending')
    await call('POST', `/tasks/${task.id}/permission-requests/${request.id}`, { decision: 'deny' })
    expect((await reply(task.id)).message).toContain('The user denied this tool call')
  })

  it('leaves an answered request alone once its time passes', async () => {
    const task = await newTask()
    const request = await raise(task.id, 'pnpm build')
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    await call('POST', `/tasks/${task.id}/permission-requests/${request.id}`, { decision: 'allow' })
    expect((await reply(task.id)).behavior).toBe('allow')
    await vi.advanceTimersByTimeAsync(120 * MINUTE)
    expect((await requestsOf(task.id)).at(-1)).toMatchObject({ state: 'allowed', timed_out: false })
    expect(await timedOutAudits(task.id)).toBeUndefined()
  })

  it('arms pending requests again after a restart, from when each was raised', async () => {
    const task = await newTask()
    await raise(task.id, 'make docs')
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    await restart()
    await vi.advanceTimersByTimeAsync(39 * MINUTE)
    expect((await requestsOf(task.id)).at(-1)?.state).toBe('pending')
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    expect(await stateOf(task.id, 'denied')).toMatchObject({ timed_out: true })
    expect((await reply(task.id)).message).toBe(timedOutMessage(60))
  })

  it('denies a request at startup when its time passed while Seti was down', async () => {
    const task = await newTask()
    await raise(task.id, 'make site')
    await restart(90 * MINUTE)
    await vi.advanceTimersByTimeAsync(1)
    expect(await stateOf(task.id, 'denied')).toMatchObject({ timed_out: true })
    expect((await reply(task.id)).message).toBe(timedOutMessage(60))
  })

  it('closes a request whose session is gone without a word, a rule or an audit event', async () => {
    const task = await newTask()
    const orphan = await permissionRequests.open({
      id: randomUUID(),
      task_id: task.id,
      tool_name: 'Bash',
      kind: 'tool',
      summary: 'make clean',
      input: '{}',
      reason: null,
      suggestions: ['Bash(make clean:*)'],
      editable: false,
      timeout_minutes: 15,
    })
    await resumePermissionTimeouts()
    await vi.advanceTimersByTimeAsync(16 * MINUTE)
    await vi.waitFor(async () => {
      expect(await permissionRequests.get(orphan.id)).toMatchObject({ state: 'cancelled', timed_out: false })
    })
    expect(await timedOutAudits(task.id)).toBeUndefined()
    expect((await messages.page(task.id, 50)).messages).toEqual([])
    expect(await rulesOf(task.id)).toEqual([])
  })

  it('applies a new timeout to pending requests from when each was raised', async () => {
    const task = await newTask()
    const request = await raise(task.id, 'make lint')
    await call('PUT', '/permissions/timeout', { request_timeout_minutes: 240 })
    const later = (await requestsOf(task.id)).at(-1)
    expect(Date.parse(later?.timeout_at ?? '') - Date.parse(request.created_at)).toBe(240 * MINUTE)
    await vi.advanceTimersByTimeAsync(61 * MINUTE)
    expect((await requestsOf(task.id)).at(-1)?.state).toBe('pending')

    await call('PUT', '/permissions/timeout', { request_timeout_minutes: 15 })
    expect(await stateOf(task.id, 'denied')).toMatchObject({ timed_out: true })
    expect((await reply(task.id)).message).toBe(timedOutMessage(15))
  })

  it('lets only the user change the timeout, and audits the old and new value', async () => {
    const task = await newTask()
    const input = { request_timeout_minutes: 1440 } as const
    await expect(call('PUT', '/permissions/timeout', input, EA_AUTH)).rejects.toThrow('403')
    await expect(asAgent(task, async () => setPermissionTimeout(input))).rejects.toThrow(
      'Agents cannot change the permission request timeout',
    )
    await expect(call('PUT', '/permissions/timeout', { request_timeout_minutes: 5 })).rejects.toThrow('400')
    const read = await call<PermissionTimeoutSettings>('GET', '/permissions/timeout', undefined, EA_AUTH)
    expect(read.request_timeout_minutes).toBe(60)

    expect((await call<PermissionTimeoutSettings>('PUT', '/permissions/timeout', input)).request_timeout_minutes).toBe(
      1440,
    )
    await auditEvents.settled()
    expect(await auditEvents.latest('system.permission_timeout_changed')).toMatchObject({
      actor: 'user',
      summary: 'Set the permission request timeout to 24 h, was 1 h',
      detail: { from: 60, to: 1440 },
    })
  })
})
