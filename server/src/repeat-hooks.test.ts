import type { HookInput, HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk'
import type { AutoArchiveStatus, PermissionRequest, Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { updateAutoArchive } from './archive.js'
import { tasks } from './db.js'
import { endSession, runTurn } from './runner.js'
import { auditEvents } from './store/audit.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

/** A tool call the fake plays: its command, what it prints, and the subagent that makes it. */
interface Play {
  command: string
  result: string
  agent?: string
}

/** Plays the calls its prompt lists through Seti's hooks, as Claude Code would, and says what ran. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const fire = async (options: Options, input: HookInput, signal: AbortSignal): Promise<HookJSONOutput[]> => {
    const tool = 'tool_name' in input ? input.tool_name : ''
    const matching = (options.hooks?.[input.hook_event_name] ?? []).filter(
      (m) => m.matcher === undefined || new RegExp(`^(?:${m.matcher})$`).test(tool),
    )
    return Promise.all(matching.flatMap((m) => m.hooks.map(async (hook) => hook(input, undefined, { signal }))))
  }
  const refusal = (outputs: HookJSONOutput[]) =>
    outputs
      .map((output) => ('hookSpecificOutput' in output ? output.hookSpecificOutput : undefined))
      .map((own) => (own?.hookEventName === 'PreToolUse' ? own : undefined))
      .find((own) => own?.permissionDecision === 'deny')?.permissionDecisionReason
  const fake = new FakeSdk(async function* (turn) {
    const { calls, force } = JSON.parse(turn.text) as { calls: Play[]; force?: boolean }
    const { options } = turn.session
    const outcomes: string[] = []
    for (const [index, played] of calls.entries()) {
      const base = {
        session_id: 's',
        transcript_path: '',
        cwd: '/tmp',
        tool_name: 'Bash',
        tool_input: { command: played.command },
        tool_use_id: `toolu_${String(index)}`,
        ...(played.agent === undefined ? {} : { agent_id: played.agent }),
      }
      const refused = refusal(await fire(options, { ...base, hook_event_name: 'PreToolUse' }, turn.signal))
      outcomes.push(refused === undefined ? 'ran' : `denied: ${refused}`)
      if (refused === undefined || force === true) {
        const tool_response = { stdout: played.result, stderr: '', interrupted: false, durationMs: index }
        await fire(options, { ...base, hook_event_name: 'PostToolUse', tool_response }, turn.signal)
      }
    }
    yield fakeAssistant(JSON.stringify(outcomes))
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
const REASON = 'Runs the same Bash command again after 2 identical results'

async function newTask(): Promise<Task> {
  const id = `repeat-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  created.push(id)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.request(`/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as { data: T; error?: { detail: string } }
  if (res.status !== 200) {
    throw new Error(`${String(res.status)} ${json.error?.detail ?? ''}`)
  }
  return json.data
}

const same = (count: number, agent?: string): Play[] =>
  Array.from({ length: count }, () => ({
    command: 'pnpm build',
    result: 'error TS2304',
    ...(agent === undefined ? {} : { agent }),
  }))

/** Plays the calls as one turn and returns what ran, answering each question with `answers`. */
async function play(task: Task, calls: Play[], answers: object[] = [], force = false): Promise<string[]> {
  await runTurn(task.id, JSON.stringify({ calls, force }))
  for (const answer of answers) {
    const request = await waitingRequest(task.id)
    await call('POST', `/tasks/${task.id}/permission-requests/${request.id}`, answer)
  }
  await waitIdle(task.id)
  const page = await call<{
    messages: { kind: string; payload: { type?: string; message?: { content: { text?: string }[] } } }[]
  }>('GET', `/tasks/${task.id}/messages`)
  const replies = page.messages.filter((row) => row.kind === 'sdk' && row.payload.type === 'assistant')
  return JSON.parse(replies.at(-1)?.payload.message?.content[0]?.text ?? '[]') as string[]
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

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('the repeat guard', () => {
  it('lets the same call run on when its result changes each time', async () => {
    const calls = ['1 pending', '2 pending', '3 pending', '4 pending'].map((result) => ({
      command: 'gh pr checks 12',
      result,
    }))
    expect(await play(await newTask(), calls)).toEqual(['ran', 'ran', 'ran', 'ran'])
  })

  it('asks before the third identical call, with a reason line, and Allow lets it run', async () => {
    const task = await newTask()
    await runTurn(task.id, JSON.stringify({ calls: same(3) }))
    const request = await waitingRequest(task.id)
    expect(request).toMatchObject({ kind: 'repeat', tool_name: 'Bash', summary: 'pnpm build', reason: REASON })
    expect(request.suggestions).toEqual([])
    await vi.waitFor(async () => {
      expect((await call<Task>('GET', `/tasks/${task.id}`)).blocked).toBe(REASON)
    })
    await auditEvents.settled()
    expect(await auditEvents.latest('task.repeat_stopped')).toMatchObject({ subject_id: task.id, actor: 'system' })

    await call('POST', `/tasks/${task.id}/permission-requests/${request.id}`, { decision: 'allow' })
    await waitIdle(task.id)
    expect((await call<Task>('GET', `/tasks/${task.id}`)).blocked).toBeNull()
    await auditEvents.settled()
    expect((await auditEvents.latest('task.permission_allowed'))?.detail).toMatchObject({ repeat: true })
  })

  it('starts the count again after Allow, and tells the agent what the user said with a deny', async () => {
    const task = await newTask()
    const answers = [{ decision: 'allow' }, { decision: 'deny', message: 'Fix the import first' }]
    expect(await play(task, same(5), answers)).toEqual([
      'ran',
      'ran',
      'ran',
      'ran',
      'denied: The user denied this tool call and said: Fix the import first',
    ])
  })

  it('stops asking about the call for the session on Always', async () => {
    const task = await newTask()
    expect(await play(task, same(6), [{ decision: 'always' }])).toEqual(['ran', 'ran', 'ran', 'ran', 'ran', 'ran'])
    await auditEvents.settled()
    expect((await auditEvents.latest('task.permission_allowed'))?.summary).toContain('stopped asking about this repeat')
  })

  it('counts a subagent apart from the agent', async () => {
    const task = await newTask()
    const calls = [...same(1), ...same(1, 'sub-a'), ...same(1), ...same(1, 'sub-a'), ...same(1, 'sub-b')]
    expect(await play(task, calls)).toEqual(['ran', 'ran', 'ran', 'ran', 'ran'])
  })

  it('leaves a command the shell guard refuses to that guard', async () => {
    const calls = Array.from({ length: 3 }, () => ({ command: 'pkill node', result: '' }))
    const outcomes = await play(await newTask(), calls, [], true)
    expect(outcomes.every((outcome) => outcome.startsWith('denied: Agents do not kill processes by name'))).toBe(true)
  })

  it('asks nothing while the setting is off, which agents cannot change', async () => {
    const task = await newTask()
    await expect(asAgent(task, async () => updateAutoArchive({ repeat_guard: false }))).rejects.toThrow(
      'Agents cannot turn the repeat guard on or off',
    )
    const off = await call<AutoArchiveStatus>('PUT', '/archive/settings', { repeat_guard: false })
    expect(off.settings.repeat_guard).toBe(false)
    try {
      await auditEvents.settled()
      expect((await auditEvents.latest('system.repeat_guard_changed'))?.summary).toBe('Turned the repeat guard off')
      expect(await play(task, same(4))).toEqual(['ran', 'ran', 'ran', 'ran'])
    } finally {
      await call('PUT', '/archive/settings', { repeat_guard: true })
    }
  })
})
