import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  COMPACT_DEFAULTS,
  COMPACT_TEMPLATE,
  compactedAtPct,
  type CompactRule,
  type CompactSettings,
  type Task,
  type TaskCompactRule,
} from '@seti/shared'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { withContextWindow } from './compact.js'
import { tasks } from './db.js'
import { sessionOptions, setupKey } from './session-options.js'
import { auditEvents } from './store/audit.js'
import { compactSettings } from './store/compact.js'
import { USER_AUTH } from './test-auth.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-compact-'))
const app = createApp()

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, data: (text === '' ? null : (JSON.parse(text) as { data: T }).data) as T }
}

let count = 0
async function newTask(): Promise<Task> {
  const id = `compact-task-${String(++count)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: scratch, worktree: false, sandbox: false, pr_urls: [] })
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('Task was not stored')
  }
  return task
}

const RULE: CompactRule = { auto: false, window_k: 200, threshold_pct: 70, instructions: 'Keep the files changed.' }

const settingsOf = (options: Options) => (typeof options.settings === 'object' ? options.settings : {})

async function preCompact(options: Options): Promise<unknown> {
  const hook: HookCallback | undefined = options.hooks?.PreCompact?.[0]?.hooks[0]
  if (hook === undefined) {
    throw new Error('No PreCompact hook')
  }
  const input = {
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    custom_instructions: null,
    session_id: 's',
    transcript_path: '/t',
    cwd: scratch,
  } as const
  return hook(input, undefined, { signal: new AbortController().signal })
}

afterEach(async () => {
  await compactSettings.set(COMPACT_DEFAULTS)
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the default compaction rule', () => {
  it("starts as Claude Code's own, saves a rule with blank instructions as none, and audits it", async () => {
    expect((await send<CompactSettings>('GET', '/compact')).data.rule).toEqual(COMPACT_DEFAULTS)
    const saved = await send<CompactSettings>('PUT', '/compact', { ...RULE, instructions: '   ' })
    expect(saved.status).toBe(200)
    expect(saved.data.rule).toEqual({ ...RULE, instructions: null })
    expect((await send<CompactSettings>('GET', '/compact')).data.rule).toEqual({ ...RULE, instructions: null })
    expect(await auditEvents.latest('system.compact_changed')).toMatchObject({ detail: { window_k: 200 } })
  })

  it('refuses a percentage without a window, and a window out of range', async () => {
    expect((await send('PUT', '/compact', { ...RULE, window_k: null })).status).toBe(400)
    expect((await send('PUT', '/compact', { ...RULE, window_k: 50 })).status).toBe(400)
  })
})

describe('the compaction rule of an agent', () => {
  it('takes the default until it has its own, and goes back to it', async () => {
    const task = await newTask()
    await send('PUT', '/compact', { ...COMPACT_DEFAULTS, instructions: 'Keep open decisions.' })
    const first = await send<TaskCompactRule>('GET', `/tasks/${task.id}/compact`)
    expect(first.data).toEqual({
      override: null,
      effective: { ...COMPACT_DEFAULTS, instructions: 'Keep open decisions.' },
    })
    const own = await send<TaskCompactRule>('PUT', `/tasks/${task.id}/compact`, { rule: RULE })
    expect(own.data).toEqual({ override: RULE, effective: RULE })
    expect(await auditEvents.latest('task.compact_changed')).toMatchObject({ subject_id: task.id })
    const back = await send<TaskCompactRule>('PUT', `/tasks/${task.id}/compact`, { rule: null })
    expect(back.data.override).toBeNull()
  })

  it('starts the session with the rule through Claude Code settings, env and a PreCompact hook', async () => {
    const task = await newTask()
    const plain = await sessionOptions(task, new AbortController())
    expect(settingsOf(plain)).toMatchObject({ autoCompactEnabled: true })
    expect(settingsOf(plain)).not.toHaveProperty('autoCompactWindow')
    expect(plain.env).not.toHaveProperty('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
    expect(await preCompact(plain)).toEqual({ systemMessage: COMPACT_TEMPLATE })

    await send('PUT', `/tasks/${task.id}/compact`, { rule: RULE })
    const ruled = await sessionOptions(task, new AbortController())
    expect(settingsOf(ruled)).toMatchObject({ autoCompactEnabled: false, autoCompactWindow: 200_000 })
    expect(ruled.env).toMatchObject({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' })
    expect(ruled.hooks?.PreToolUse?.length).toBeGreaterThan(0)
    expect(await preCompact(ruled)).toEqual({ systemMessage: 'Keep the files changed.' })
  })

  it('restarts the session for a new window, but hands new instructions to the running one', async () => {
    const task = await newTask()
    await send('PUT', `/tasks/${task.id}/compact`, { rule: RULE })
    const first = await setupKey(task)
    await send('PUT', `/tasks/${task.id}/compact`, { rule: { ...RULE, instructions: 'Keep the plan.' } })
    expect(await setupKey(task)).toBe(first)
    const options = await sessionOptions(task, new AbortController())
    expect(await preCompact(options)).toEqual({ systemMessage: 'Keep the plan.' })
    await send('PUT', `/tasks/${task.id}/compact`, { rule: { ...RULE, window_k: 300 } })
    expect(await setupKey(task)).not.toBe(first)
  })
})

describe('a compact boundary', () => {
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 164_000 },
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 's',
  } as const satisfies SDKMessage

  it('keeps the context window it was measured against, for how full it was', async () => {
    const stored = await withContextWindow(boundary, async () => Promise.resolve(200_000))
    expect(compactedAtPct(stored, boundary.compact_metadata.pre_tokens)).toBe(82)
  })

  it('is stored as it came when the window is unknown, and other messages never ask', async () => {
    expect(await withContextWindow(boundary, async () => Promise.resolve(null))).toBe(boundary)
    const asked: string[] = []
    const status = { type: 'system', subtype: 'status', status: null, uuid: boundary.uuid, session_id: 's' } as const
    await withContextWindow(status, async () => {
      asked.push('window')
      return Promise.resolve(1)
    })
    expect(asked).toEqual([])
  })
})
