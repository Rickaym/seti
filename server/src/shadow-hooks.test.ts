import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CanUseTool, HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk'
import type { Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { sql, tasks } from './db.js'
import './session-ingest.js'
import { shadowHooks } from './shadow-hooks.js'
import { permissionRules } from './store/permissions.js'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-shadow-'))

async function newTask(): Promise<Task> {
  const id = `shadow-${String(Date.now())}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: work, worktree: false, sandbox: false, pr_urls: [] })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('Task was not stored')
  }
  return task
}

const base = { session_id: 's', transcript_path: '', cwd: work, permission_mode: 'auto' }

async function fire(matchers: HookCallbackMatcher[] | undefined, input: HookInput): Promise<unknown[]> {
  const signal = new AbortController().signal
  return Promise.all((matchers ?? []).flatMap((m) => m.hooks.map(async (hook) => hook(input, undefined, { signal }))))
}

interface Row {
  verdict: string
  step: string
  runtime: string
  result: string
  calls: number
  tool: string
}

const rowsOf = async (rule: string) =>
  sql<Row[]>`SELECT verdict, step, runtime, result, calls, tool FROM policy_shadow WHERE rule = ${rule}`

describe('the permission shadow', () => {
  it('counts how Seti decision compares with what Claude Code did, and changes nothing', async () => {
    const task = await newTask()
    const allow = (await permissionRules.add(task.id, 'allow', 'Bash(make shadow-check)')).rule
    const deny = (await permissionRules.add(task.id, 'deny', 'Read(//srv/shadow-secret)')).rule
    const session = new AbortController()
    const shadow = shadowHooks(task, false, session.signal)
    const pre = async (id: string, tool: string, toolInput: Record<string, unknown>) =>
      fire(shadow.hooks.PreToolUse, {
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: toolInput,
        tool_use_id: id,
      })

    expect(await pre('t1', 'Bash', { command: 'make shadow-check' })).toEqual([{}])
    await fire(shadow.hooks.PostToolUse, {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'ok',
      tool_use_id: 't1',
    })
    await vi.waitFor(async () => {
      expect(await rowsOf(`rule:${String(allow.id)}`)).toEqual([
        { verdict: 'allow', step: 'allow-rule', runtime: 'allow', result: 'agree', calls: 1, tool: 'Bash' },
      ])
    })

    const asked = vi.fn<CanUseTool>(async () => Promise.resolve({ behavior: 'deny', message: 'no' }))
    await shadow.observe(asked)(
      'Read',
      { file_path: '/srv/shadow-secret' },
      {
        signal: session.signal,
        toolUseID: 't2',
        requestId: 'r2',
      },
    )
    expect(asked).toHaveBeenCalledOnce()
    await pre('t2', 'Read', { file_path: '/srv/shadow-secret' })
    await pre('t3', 'Read', { file_path: '/srv/shadow-secret' })
    await vi.waitFor(async () => {
      expect(await rowsOf(`rule:${String(deny.id)}`)).toEqual([
        expect.objectContaining({ verdict: 'deny', runtime: 'ask', result: 'tighter', calls: 1 }),
      ])
    })
    session.abort()
    await vi.waitFor(async () => {
      const rows = await rowsOf(`rule:${String(deny.id)}`)
      expect(rows).toContainEqual(expect.objectContaining({ runtime: 'unobserved', result: 'unobserved' }))
    })
    const stored = JSON.stringify(await sql`SELECT * FROM policy_shadow`)
    expect(stored).not.toContain('shadow-secret')
    expect(stored).not.toContain('make shadow-check')
  })

  it('decides on where a path leads on disk, and stores neither path', async () => {
    const task = await newTask()
    const secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-shadow-secrets-'))
    fs.writeFileSync(path.join(secrets, 'token'), 't')
    const link = path.join(work, `linked-${task.id}`)
    fs.symlinkSync(path.join(secrets, 'token'), link)
    const deny = (await permissionRules.add(task.id, 'deny', `Read(/${secrets}/**)`)).rule
    const shadow = shadowHooks(task, false, new AbortController().signal)
    const input = { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'l1' } as const
    expect(await fire(shadow.hooks.PreToolUse, { ...input, tool_input: { file_path: link } })).toEqual([{}])
    await shadow.observe(async () => Promise.resolve({ behavior: 'deny', message: 'no' }))(
      'Read',
      { file_path: link },
      { signal: new AbortController().signal, toolUseID: 'l1', requestId: 'r1' },
    )
    await vi.waitFor(async () => {
      expect(await rowsOf(`rule:${String(deny.id)}`)).toEqual([
        expect.objectContaining({ verdict: 'deny', step: 'deny-rule', runtime: 'ask', calls: 1 }),
      ])
    })
    const stored = JSON.stringify(await sql`SELECT * FROM policy_shadow`)
    expect(stored).not.toContain(secrets)
    expect(stored).not.toContain('linked-')
  })

  it('answers at once and counts a decision that fails, without throwing it', async () => {
    const shadow = shadowHooks(await newTask(), false, new AbortController().signal)
    const failed = async () =>
      (
        await sql<{ calls: number }[]>`SELECT COALESCE(SUM(calls), 0)::int AS calls FROM policy_shadow
        WHERE result = 'failed'`
      )[0]?.calls ?? 0
    const before = await failed()
    const broken = { ...base, hook_event_name: 'PreToolUse', tool_name: null, tool_input: {}, tool_use_id: 'x1' }
    expect(await fire(shadow.hooks.PreToolUse, broken as unknown as HookInput)).toEqual([{}])
    await vi.waitFor(async () => {
      expect(await failed()).toBe(before + 1)
    })
  })
})
