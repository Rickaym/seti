import os from 'node:os'
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import type { BypassState, MessagePage, Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { resumeBypass, setBypass } from './bypass.js'
import { tasks } from './db.js'
import { allowed } from './permission-requests.js'
import { endSession, runTurn } from './runner.js'
import { sessionOptions, setupKey } from './session-options.js'
import { auditEvents } from './store/audit.js'
import { bypass } from './store/permissions.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const fake = new FakeSdk(function* () {
    yield fakeAssistant('done')
    yield fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const created: string[] = []

async function newTask(): Promise<Task> {
  const id = `bypass-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, sandbox: false, pr_urls: [] })
  created.push(id)
  return current(id)
}

async function current(id: string): Promise<Task> {
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

async function put(taskId: string, hours: number | null, auth: object = USER_AUTH) {
  const res = await app.request(`/api/tasks/${taskId}/permissions/bypass`, {
    method: 'PUT',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ hours }),
  })
  const json = (await res.json()) as { data: BypassState }
  return { status: res.status, data: json.data }
}

/** Runs the session's PreToolUse hooks on a Bash command; the first decision that refuses it. */
async function guardDecision(options: Options, command: string): Promise<unknown> {
  const hooks: HookCallback[] = (options.hooks?.PreToolUse ?? []).flatMap((matcher) => matcher.hooks)
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'toolu_1',
    session_id: 's',
    transcript_path: '/t',
    cwd: '/tmp',
  } as const
  for (const hook of hooks) {
    const out = await hook(input, 'toolu_1', { signal: new AbortController().signal })
    if ('hookSpecificOutput' in out) {
      return out.hookSpecificOutput
    }
  }
  return null
}

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('Bypass', () => {
  it('is off by default and turns on and off for the user only, audited each time', async () => {
    const task = await newTask()
    expect(task.bypass_until).toBeNull()
    expect((await put(task.id, 8, EA_AUTH)).status).toBe(403)
    await expect(asAgent(task, async () => setBypass(task, 8))).rejects.toThrow(/Agents cannot/)
    expect((await current(task.id)).bypass_until).toBeNull()

    const on = await put(task.id, 8)
    expect(on.status).toBe(200)
    const hoursLeft = (Date.parse(on.data.bypass_until ?? '') - Date.now()) / 3_600_000
    expect(hoursLeft).toBeGreaterThan(7.9)
    expect(hoursLeft).toBeLessThanOrEqual(8)
    await auditEvents.settled()
    expect(await auditEvents.latest('task.bypass_on')).toMatchObject({ subject_id: task.id, actor: 'user' })

    expect((await put(task.id, null)).data).toEqual({ bypass_until: null, applied: 'now' })
    await auditEvents.settled()
    expect(await auditEvents.latest('task.bypass_off')).toMatchObject({ subject_id: task.id })
    expect((await put(task.id, 3)).status).toBe(400)
  })

  it('starts the agent in bypass with the shell guard and the credential deny rules in place', async () => {
    const task = await newTask()
    await put(task.id, 2)
    const options = await sessionOptions(await current(task.id), new AbortController())
    expect(options.permissionMode).toBe('bypassPermissions')
    expect(options.allowDangerouslySkipPermissions).toBe(true)
    const deny = typeof options.settings === 'object' ? (options.settings.permissions?.deny ?? []) : []
    expect(deny).toContain(`Edit(/${os.homedir()}/.ssh/**)`)
    expect(deny).toContain(`Edit(/${os.homedir()}/.aws/**)`)
    expect(await guardDecision(options, 'rm -rf ~')).toMatchObject({ permissionDecision: 'deny' })
    expect(await guardDecision(options, 'pkill -f node')).toMatchObject({ permissionDecision: 'deny' })
    expect(await guardDecision(options, 'git status')).toBeNull()

    await put(task.id, null)
    const plain = await sessionOptions(await current(task.id), new AbortController())
    expect(plain.permissionMode).toBe('auto')
    expect(plain.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('switches a process started with it live, and one started without it at the next turn', async () => {
    const task = await newTask()
    await runTurn(task.id, 'hello')
    await waitIdle(task.id)
    const before = await setupKey(await current(task.id))
    expect((await put(task.id, 8)).data.applied).toBe('next_turn')
    expect(await setupKey(await current(task.id))).not.toBe(before)

    await runTurn(task.id, 'again')
    await waitIdle(task.id)
    expect(sdk.fake.last?.options.permissionMode).toBe('bypassPermissions')
    expect((await put(task.id, null)).data.applied).toBe('now')
    expect(sdk.fake.last?.modes).toEqual(['auto'])
  })

  it('ends a Bypass that ran out, with an audit entry and a note in the transcript', async () => {
    const task = await newTask()
    await bypass.set(task.id, new Date(Date.now() - 1000).toISOString())
    await resumeBypass()
    expect((await current(task.id)).bypass_until).toBeNull()
    await auditEvents.settled()
    expect(await auditEvents.latest('task.bypass_expired')).toMatchObject({ subject_id: task.id, actor: 'system' })
    const res = await app.request(`/api/tasks/${task.id}/messages`, { headers: { host: 'localhost', ...USER_AUTH } })
    const page = ((await res.json()) as { data: MessagePage }).data
    expect(page.messages.at(-1)).toMatchObject({ kind: 'seti', payload: { bypass: false } })
  })

  it('goes on in bypass after an approved plan while Bypass lasts', () => {
    const plan = { tool_name: 'ExitPlanMode' }
    expect(allowed(plan, {}, 'bypassPermissions').updatedPermissions).toEqual([
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    ])
    expect(allowed(plan, {}, 'auto').updatedPermissions?.[0]).toMatchObject({ mode: 'auto' })
  })
})
