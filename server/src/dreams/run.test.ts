import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { claudeToolCall, type AuditPage, type DreamRun, type Revision } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { audit } from '../audit.js'
import { findBinary } from '../binaries.js'
import { messages, tasks } from '../db.js'
import type { DreamHost, DreamSession, DreamSpec, DreamSupport, SessionReport } from '../runtimes/adapter.js'
import { claudeMemory } from '../runtimes/claude/dream.js'
import { adapterFor } from '../runtimes/registry.js'
import { DREAM_TOOLS } from '../seti-tools/dreams.js'
import { callSetiTool } from '../seti-tools/server.js'
import { taskArchives } from '../store/archive.js'
import { dreamRuns, type DreamEnd } from '../store/dreams.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { keepBefore, keptBefore } from './kept.js'
import { snapshotMemory } from './memory-snapshot.js'
import { dreamPreface } from './preface.js'
import { cutDreamsAtStart } from './start.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-dream-run-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const bwrap = (() => {
  try {
    execFileSync(findBinary('bwrap'), ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'])
    return true
  } catch {
    return false
  }
})()

const app = createApp()
const TOKEN = `ghp_${'Q7w6'.repeat(9)}`
const claude = adapterFor('claude')
const real = claude.capabilities.dream

afterAll(() => {
  claude.capabilities.dream = real
  fs.rmSync(scratch, { recursive: true, force: true })
})

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(
  method: string,
  url: string,
  body?: unknown,
  auth: Record<string, string> = USER_AUTH,
): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = (await res.json()) as { data?: T; error?: { detail: string } }
  return { status: res.status, data: (parsed.data ?? parsed.error?.detail ?? null) as T }
}

/** A runtime whose dream writes one memory line, tries a forbidden write, and reports. */
function fakeDream(): { dream: DreamSupport; seen: { spec?: DreamSpec; refused?: string | null } } {
  const seen: { spec?: DreamSpec; refused?: string | null } = {}
  const dream: DreamSupport = {
    memory: claudeMemory,
    open: async (spec: DreamSpec, _launcher, host: DreamHost) => {
      seen.spec = spec
      const inside = /Memory folder: (\S+)\./.exec(spec.prompt)?.[1] ?? ''
      const file = path.join(claudeMemory(spec.cwd), 'MEMORY.md')
      const outside = claudeToolCall('w0', 'Write', { file_path: path.join(spec.cwd, 'x.md'), content: 'x' })
      seen.refused = host.gate(outside)
      const line = '- deploy through the proxy [user 2026-11-23]\n'
      const write = claudeToolCall('w1', 'Write', { file_path: path.join(inside, 'MEMORY.md'), content: line })
      if (host.gate(write) === null) {
        fs.writeFileSync(file, line)
      }
      await host.tools[0]?.call({ summary: 'Merged the deploy notes', tidied: ['MEMORY.md: one deploy rule'] })
      const finish: SessionReport = {
        type: 'message',
        raw: {},
        work: false,
        byAgent: true,
        delivered: [],
        events: [
          {
            v: 1,
            thread: '',
            type: 'turn.ended',
            turnId: 't',
            status: 'ok',
            result: 'done',
            cause: 'input',
            costUsd: 0.21,
            answered: [],
          },
        ],
      }
      const session: DreamSession = {
        events: (async function* () {
          yield await Promise.resolve(finish)
        })(),
        interrupt: async () => Promise.resolve(),
        close: () => undefined,
      }
      return Promise.resolve(session)
    },
  }
  return { dream, seen }
}

async function agent(patch: { sandbox?: boolean; seti_control?: 'full' } = {}) {
  const id = randomUUID()
  const cwd = path.join(scratch, 'work', id)
  fs.mkdirSync(cwd, { recursive: true })
  await tasks.insert({ id, title: 'Lead', repo_id: null, cwd, worktree: false, pr_urls: [], sandbox: true, ...patch })
  const memory = claudeMemory(cwd)
  fs.mkdirSync(memory, { recursive: true })
  fs.writeFileSync(path.join(memory, 'MEMORY.md'), `- deploy with ${TOKEN}\n- old note\n`)
  await messages.insert(id, { kind: 'prompt', payload: { text: `Never push to main. The key is ${TOKEN}` } }, [])
  return { id, cwd, memory }
}

async function ended(taskId: string): Promise<DreamRun> {
  return vi.waitFor(
    async () => {
      const [run] = (await send<DreamRun[]>('GET', `/tasks/${taskId}/dreams`)).data
      if (run === undefined || run.state === 'running') {
        throw new Error('still dreaming')
      }
      return run
    },
    { timeout: 15_000, interval: 100 },
  )
}

/** The agent's dream events as the audit chain holds them, oldest first. */
async function dreamEvents(taskId: string): Promise<AuditPage['events']> {
  const page = await send<AuditPage>('GET', '/audit?area=dream&limit=200')
  return page.data.events.filter((event) => event.subject_id === taskId).reverse()
}

const dreamKinds = async (taskId: string) => (await dreamEvents(taskId)).map((event) => event.kind)

const DONE: DreamEnd = {
  state: 'done',
  reason: null,
  cost_usd: 0,
  steps: 0,
  denials: 0,
  memory_changes: 0,
  report: null,
}

describe('the end of a dream', () => {
  it('ends a dream that a restart cut once, after recording what it changed in memory', async () => {
    const { id, memory } = await agent()
    const run = await dreamRuns.start({ task_id: id, night: '2026-11-23', kind: 'manual', model: 'claude-sonnet-5-5' })
    const before = await snapshotMemory(memory)
    if (!before.ok) {
      throw new Error(before.reason)
    }
    keepBefore(id, run.id, before.files)
    fs.writeFileSync(path.join(memory, 'MEMORY.md'), '- deploy through the proxy\n')
    await cutDreamsAtStart()
    await cutDreamsAtStart()
    expect(await dreamRuns.get(run.id)).toMatchObject({ state: 'cut', memory_changes: 1 })
    const events = await dreamEvents(id)
    expect(events.map((event) => event.kind)).toEqual(['dream.memory_changed', 'dream.ended'])
    expect(events[1]?.detail).toMatchObject({ run: run.id, state: 'cut', memory_changes: 1 })
    expect(keptBefore(id, run.id)).toBeNull()
    expect((await dreamPreface(id))?.text).toMatch(/changed 1 of your memory files/)
  })

  it('leaves a dream that ended already as it ended, with no second end in the audit', async () => {
    const { id } = await agent()
    const run = await dreamRuns.start({ task_id: id, night: '2026-11-23', kind: 'manual', model: 'claude-sonnet-5-5' })
    expect(await dreamRuns.end(run.id, DONE)).toMatchObject({ state: 'done' })
    expect(await dreamRuns.end(run.id, { ...DONE, state: 'failed' })).toBeUndefined()
    await cutDreamsAtStart()
    expect(await dreamRuns.get(run.id)).toMatchObject({ state: 'done' })
    expect(await dreamKinds(id)).toEqual([])
  })

  it('still ends the dream when its audit event cannot be written', async () => {
    const { id } = await agent()
    const run = await dreamRuns.start({ task_id: id, night: '2026-11-23', kind: 'manual', model: 'claude-sonnet-5-5' })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const row = await audit.recordWith(
      async (tx) => dreamRuns.end(run.id, DONE, tx),
      () => {
        throw new Error('no audit')
      },
    )
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('no audit'))
    stderr.mockRestore()
    expect(row).toMatchObject({ state: 'done' })
    expect(await dreamRuns.get(run.id)).toMatchObject({ state: 'done' })
  })
})

describe.skipIf(!bwrap)('Dream now', () => {
  it('shows no dream as ended before its end is in the audit, after its memory changes', async () => {
    await sandboxPolicy.save({ enabled: true, allowed_domains: [], hidden_paths: [] })
    claude.capabilities.dream = fakeDream().dream
    const { id } = await agent()
    const seen: { state: string | null; kinds: string[] } = { state: null, kinds: [] }
    const end = dreamRuns.end.bind(dreamRuns)
    const spy = vi.spyOn(dreamRuns, 'end').mockImplementation(async (...args) => {
      const row = await end(...args)
      seen.state = (await dreamRuns.get(args[0]))?.state ?? null
      seen.kinds = await dreamKinds(id)
      return row
    })
    expect((await send<DreamRun>('POST', `/tasks/${id}/dream`, {})).status).toBe(200)
    await ended(id)
    spy.mockRestore()
    expect(seen).toEqual({ state: 'running', kinds: ['dream.started', 'dream.memory_changed'] })
    expect(await dreamKinds(id)).toEqual(['dream.started', 'dream.memory_changed', 'dream.ended'])
  })

  it('runs a dream that changes memory, records it, and reports, keeping secrets out', async () => {
    await sandboxPolicy.save({ enabled: true, allowed_domains: [], hidden_paths: [] })
    const { dream, seen } = fakeDream()
    claude.capabilities.dream = dream
    const { id, memory } = await agent()
    const started = await send<DreamRun>('POST', `/tasks/${id}/dream`, {})
    expect(started.status).toBe(200)
    const run = await ended(id)
    expect(run).toMatchObject({ state: 'done', memory_changes: 1, cost_usd: 0.21, denials: 1, kind: 'manual' })
    expect(run.report?.summary).toBe('Merged the deploy notes')
    expect(seen.refused).toMatch(/only its memory folder/)
    expect(seen.spec).toMatchObject({ model: 'claude-sonnet-5-5', maxTurns: 60, budgetUsd: 1 })
    const digestPath = /Digest: (\S+)\./.exec(seen.spec?.prompt ?? '')?.[1] ?? ''
    const digest = fs.readFileSync(digestPath, 'utf8')
    expect(digest).toContain('Never push to main')
    expect(digest).not.toContain(TOKEN)
    expect(fs.readFileSync(path.join(path.dirname(digestPath), 'report.md'), 'utf8')).toContain(
      'Merged the deploy notes',
    )
    const [revision] = (await send<Revision[]>('GET', `/revisions?object_type=memory_file&task_id=${id}`)).data
    expect(revision).toMatchObject({ actor: 'system', reason: `dream ${run.night}` })
    expect(JSON.stringify(revision)).not.toContain(TOKEN)
    expect(fs.readFileSync(path.join(memory, 'MEMORY.md'), 'utf8')).toContain('through the proxy')
    expect(await dreamKinds(id)).toEqual(['dream.started', 'dream.memory_changed', 'dream.ended'])
    expect((await dreamPreface(id))?.text).toMatch(/changed 1 of your memory files/)
  })

  it('refuses an archived or unsandboxed agent, and one Claude Code tidied within the hour', async () => {
    claude.capabilities.dream = fakeDream().dream
    const loose = await agent({ sandbox: false })
    expect((await send<string>('POST', `/tasks/${loose.id}/dream`, {})).data).toMatch(/without the sandbox/)
    const locked = await agent()
    fs.writeFileSync(path.join(locked.memory, '.consolidate-lock'), '4242')
    expect((await send<string>('POST', `/tasks/${locked.id}/dream`, {})).data).toMatch(/within the hour/)
    const archived = await agent()
    await taskArchives.archive(archived.id, 'user')
    const res = await send<string>('POST', `/tasks/${archived.id}/dream`, {})
    expect(res.status).toBe(409)
    expect(res.data).toMatch(/archived/)
  })

  it('audits who started a dream and lets the EA and agents start one a day, never on themselves', async () => {
    claude.capabilities.dream = fakeDream().dream
    const { id } = await agent()
    expect((await send<DreamRun>('POST', `/tasks/${id}/dream`, {}, EA_AUTH)).status).toBe(200)
    await ended(id)
    const started = (await dreamEvents(id)).find((e) => e.kind === 'dream.started')
    expect(started?.detail).toMatchObject({ via: 'ea' })
    const again = await send<string>('POST', `/tasks/${id}/dream`, {}, EA_AUTH)
    expect([again.status, again.data]).toEqual([409, expect.stringMatching(/dreamt today already/)])
    const lead = await agent({ seti_control: 'full' })
    const tool = DREAM_TOOLS[0]
    if (tool === undefined) {
      throw new Error('No dreams tool')
    }
    const own = await callSetiTool(tool, lead.id, { task: lead.id, start: true })
    expect([own.isError, own.content[0]?.text]).toEqual([true, expect.stringMatching(/cannot start a dream of/)])
    expect((await callSetiTool(tool, lead.id, { task: id, start: true })).content[0]?.text).toMatch(/today already/)
    expect((await send<DreamRun>('POST', `/tasks/${id}/dream`, {})).status).toBe(200)
    await ended(id)
  })

  it('refuses a runtime that declares no dreams', async () => {
    claude.capabilities.dream = null
    const { id } = await agent()
    expect((await send<string>('POST', `/tasks/${id}/dream`, {})).data).toMatch(/keeps no memory/)
  })
})
