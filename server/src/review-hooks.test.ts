import type { HookInput, HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionRequest, PermissionRule, Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { namesTool } from './review-hooks.js'
import { endSession, runTurn } from './runner.js'
import { auditEvents } from './store/audit.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

/** An MCP call the fake plays: the tool and its input. */
interface Play {
  tool: string
  input: Record<string, unknown>
}

/** Plays its prompt's calls through Seti's PreToolUse hooks and says what each ran with. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  type Own = Extract<
    NonNullable<Extract<HookJSONOutput, { hookSpecificOutput?: unknown }>['hookSpecificOutput']>,
    { hookEventName: 'PreToolUse' }
  >
  const fire = async (options: Options, input: HookInput, signal: AbortSignal): Promise<Own[]> => {
    const tool = 'tool_name' in input ? input.tool_name : ''
    const matching = (options.hooks?.PreToolUse ?? []).filter(
      (m) => m.matcher === undefined || new RegExp(`^(?:${m.matcher})$`).test(tool),
    )
    const outputs = await Promise.all(
      matching.flatMap((m) => m.hooks.map(async (hook) => hook(input, undefined, { signal }))),
    )
    return outputs.flatMap((output) =>
      'hookSpecificOutput' in output && output.hookSpecificOutput.hookEventName === 'PreToolUse'
        ? [output.hookSpecificOutput]
        : [],
    )
  }
  const fake = new FakeSdk(async function* (turn) {
    const calls = JSON.parse(turn.text) as Play[]
    const results: string[] = []
    for (const [index, played] of calls.entries()) {
      const own = await fire(
        turn.session.options,
        {
          session_id: 's',
          transcript_path: '',
          cwd: '/tmp',
          hook_event_name: 'PreToolUse',
          tool_name: played.tool,
          tool_input: played.input,
          tool_use_id: `toolu_${String(index)}`,
        },
        turn.signal,
      )
      const refused = own.find((output) => output.permissionDecision === 'deny')
      const ran = own.find((output) => output.updatedInput !== undefined)?.updatedInput ?? played.input
      results.push(
        refused === undefined ? `ran ${JSON.stringify(ran)}` : `denied: ${refused.permissionDecisionReason ?? ''}`,
      )
    }
    yield fakeAssistant(JSON.stringify(results))
    yield fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const created: string[] = []
const SEND = 'mcp__chat__send_message'

async function newTask(): Promise<Task> {
  const id = `review-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body)
  const json = (await res.json()) as { data: T; error?: { detail: string } }
  if (res.status !== 200) {
    throw new Error(`${String(res.status)} ${json.error?.detail ?? ''}`)
  }
  return json.data
}

async function review(task: Task, rule: string): Promise<PermissionRule> {
  return call<PermissionRule>('POST', `/tasks/${task.id}/permissions/rules`, { behavior: 'review', rule })
}

async function waitingRequest(taskId: string): Promise<PermissionRequest> {
  return vi.waitFor(
    async () => {
      const requests = await call<PermissionRequest[]>('GET', `/tasks/${taskId}/permission-requests`)
      const request = requests.find((r) => r.state === 'pending')
      if (request === undefined) {
        throw new Error('No request waits yet')
      }
      return request
    },
    { interval: 10 },
  )
}

async function outcomes(task: Task): Promise<string[]> {
  await waitIdle(task.id)
  const page = await call<{
    messages: { kind: string; payload: { type?: string; message?: { content: { text?: string }[] } } }[]
  }>('GET', `/tasks/${task.id}/messages`)
  const replies = page.messages.filter((row) => row.kind === 'sdk' && row.payload.type === 'assistant')
  return JSON.parse(replies.at(-1)?.payload.message?.content[0]?.text ?? '[]') as string[]
}

const message = (text: string): Play => ({ tool: SEND, input: { channel: 'C1', text } })

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('review rules', () => {
  it('match a tool by its name or its server, bare or with __*', () => {
    expect(namesTool(SEND, SEND)).toBe(true)
    expect(namesTool('mcp__chat', SEND)).toBe(true)
    expect(namesTool('mcp__chat__*', SEND)).toBe(true)
    expect(namesTool('mcp__chatter', SEND)).toBe(false)
    expect(namesTool('mcp__chat__send', SEND)).toBe(false)
  })

  it('take only an MCP tool or server', async () => {
    const task = await newTask()
    const res = await send('POST', `/tasks/${task.id}/permissions/rules`, { behavior: 'review', rule: 'Bash' })
    expect(res.status).toBe(400)
  })

  it('let a call no review rule names run without asking', async () => {
    const task = await newTask()
    await review(task, 'mcp__other')
    await runTurn(task.id, JSON.stringify([message('Hello')]))
    expect(await outcomes(task)).toEqual([`ran ${JSON.stringify({ channel: 'C1', text: 'Hello' })}`])
  })

  it('hold the call for review, and Allow runs it with the edited fields', async () => {
    const task = await newTask()
    await review(task, 'mcp__chat')
    await runTurn(task.id, JSON.stringify([message('Deploy is dnoe')]))
    const request = await waitingRequest(task.id)
    expect(request).toMatchObject({ kind: 'review', tool_name: SEND, editable: true, summary: 'Deploy is dnoe' })
    expect(request.suggestions).toEqual([])

    await call('POST', `/tasks/${task.id}/permission-requests/${request.id}`, {
      decision: 'allow',
      fields: { text: 'Deploy is done' },
    })
    expect(await outcomes(task)).toEqual([`ran ${JSON.stringify({ channel: 'C1', text: 'Deploy is done' })}`])
    const settled = await call<PermissionRequest[]>('GET', `/tasks/${task.id}/permission-requests`)
    expect(settled.at(-1)?.input).toContain('Deploy is done')
    await auditEvents.settled()
    const event = await auditEvents.latest('task.permission_allowed')
    expect(event?.detail).toMatchObject({ review: true, edited: ['text'] })
    expect(JSON.stringify(event?.detail)).not.toContain('Deploy is done')
  })

  it('leave a call a deny rule names to that rule, without a review', async () => {
    const task = await newTask()
    await review(task, 'mcp__chat')
    await call('POST', `/tasks/${task.id}/permissions/rules`, { behavior: 'deny', rule: SEND })
    await runTurn(task.id, JSON.stringify([message('Hello')]))
    await outcomes(task)
    expect(await call<PermissionRequest[]>('GET', `/tasks/${task.id}/permission-requests`)).toEqual([])
  })

  it('tell the agent what the user said with a deny', async () => {
    const task = await newTask()
    await review(task, SEND)
    await runTurn(task.id, JSON.stringify([message('Ship it')]))
    const request = await waitingRequest(task.id)
    await call('POST', `/tasks/${task.id}/permission-requests/${request.id}`, {
      decision: 'deny',
      message: 'Not in that channel',
    })
    expect(await outcomes(task)).toEqual(['denied: The user denied this tool call and said: Not in that channel'])
  })

  it('refuse edits to a field the call does not have as text', async () => {
    const task = await newTask()
    await review(task, SEND)
    await runTurn(task.id, JSON.stringify([message('Hi')]))
    const request = await waitingRequest(task.id)
    const path = `/tasks/${task.id}/permission-requests/${request.id}`
    expect((await send('POST', path, { decision: 'allow', fields: { thread: 'T1' } })).status).toBe(400)
    await call('POST', path, { decision: 'allow' })
    expect(await outcomes(task)).toEqual([`ran ${JSON.stringify({ channel: 'C1', text: 'Hi' })}`])
  })

  it('never let the user edit a call shown with a value redacted', async () => {
    const task = await newTask()
    await review(task, SEND)
    const token = `ghp_${'x'.repeat(24)}`
    await runTurn(task.id, JSON.stringify([message(`Use ${token}`)]))
    const request = await waitingRequest(task.id)
    expect(request.editable).toBe(false)
    const path = `/tasks/${task.id}/permission-requests/${request.id}`
    expect((await send('POST', path, { decision: 'allow', fields: { text: 'Use it' } })).status).toBe(409)
    await call('POST', path, { decision: 'deny' })
    await outcomes(task)
  })
})
