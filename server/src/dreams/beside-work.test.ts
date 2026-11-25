import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AuditPage, DreamRun, MessageBody } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { findBinary } from '../binaries.js'
import { tasks } from '../db.js'
import { endSession, runTurn } from '../runner.js'
import type { DreamSupport } from '../runtimes/adapter.js'
import { claudeMemory } from '../runtimes/claude/dream.js'
import { adapterFor } from '../runtimes/registry.js'
import { backgroundChanged, backgroundResult, shellCall, shellStarted } from '../shell-fixtures.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { USER_AUTH } from '../test-auth.js'
import { waitIdle } from '../wait-idle.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-dream-beside-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

/** The agent's own turns: each runs what the test sets, then ends. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('../fake-sdk.js')
  const state = { turn: (_text: string): { type: string }[] => [] }
  const fake = new FakeSdk(function* ({ text }) {
    yield* state.turn(text)
    yield fakeResult()
  })
  return { state, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const bwrap = (() => {
  try {
    execFileSync(findBinary('bwrap'), ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'])
    return true
  } catch {
    return false
  }
})()

const app = createApp()
const claude = adapterFor('claude')
const real = claude.capabilities.dream
const TASK = 'dream-beside-work'
const CWD = path.join(scratch, 'work')
const payload = (body: MessageBody) => body.payload as { type: string }

/** A turn that leaves a dev server running, with a background subagent beside it if asked. */
function devServer(shell: string, agent?: string): { type: string }[] {
  const call = `toolu_${shell}`
  const subagent: [string, string, string][] = agent === undefined ? [] : [[agent, 'Review', 'local_agent']]
  return [
    payload(shellCall(call, { command: 'npm run dev', description: 'Dev server', run_in_background: true })),
    payload(backgroundChanged([shell, 'Dev server'], ...subagent)),
    payload(shellStarted({ shellId: shell, toolUseId: call, description: 'Dev server', background: true })),
    payload(backgroundResult(call, shell, scratch)),
  ]
}

/** A dream that notes one memory line and reports, then runs until it is interrupted. */
function waitingDream(): { dream: DreamSupport; opened: Promise<void> } {
  const gates = { release: (): void => undefined, open: (): void => undefined }
  const interrupted = new Promise<void>((resolve) => {
    gates.release = resolve
  })
  const opened = new Promise<void>((resolve) => {
    gates.open = resolve
  })
  const dream: DreamSupport = {
    memory: claudeMemory,
    reportedCost: () => null,
    open: async (spec, _launcher, host) => {
      fs.appendFileSync(path.join(claudeMemory(spec.cwd), 'MEMORY.md'), '- dev server on 5173 [seen 2026-11-25]\n')
      await host.tools[0]?.call({ summary: 'Noted the dev server', tidied: ['MEMORY.md: dev server port'] })
      gates.open()
      return {
        events: (async function* () {
          await interrupted
          yield* []
        })(),
        interrupt: async () => {
          gates.release()
          return Promise.resolve()
        },
        close: () => undefined,
      }
    },
  }
  return { dream, opened }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  })
  const parsed = (await res.json()) as { data?: T; error?: { detail: string } }
  return { status: res.status, data: (parsed.data ?? parsed.error?.detail ?? null) as T }
}

async function ended(): Promise<DreamRun> {
  return vi.waitFor(
    async () => {
      const [run] = (await send<DreamRun[]>('GET', `/tasks/${TASK}/dreams`)).data
      if (run === undefined || run.state === 'running') {
        throw new Error('still dreaming')
      }
      return run
    },
    { timeout: 15_000, interval: 50 },
  )
}

beforeAll(async () => {
  fs.mkdirSync(claudeMemory(CWD), { recursive: true })
  fs.writeFileSync(path.join(claudeMemory(CWD), 'MEMORY.md'), '- deploy through the proxy\n')
  await tasks.insert({ id: TASK, title: 'Dev', repo_id: null, cwd: CWD, worktree: false, pr_urls: [], sandbox: true })
  await sandboxPolicy.save({ enabled: true, allowed_domains: [], hidden_paths: [] })
})

afterAll(async () => {
  claude.capabilities.dream = real
  await endSession(TASK)
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe.skipIf(!bwrap)('a dream beside the background work of its agent', () => {
  it('refuses while a background subagent runs beside a command', async () => {
    claude.capabilities.dream = waitingDream().dream
    sdk.state.turn = () => devServer('b1', 'a1')
    await runTurn(TASK, 'start the dev server and a review')
    await waitIdle(TASK)
    const refused = await send<string>('POST', `/tasks/${TASK}/dream`)
    expect([refused.status, refused.data]).toEqual([409, expect.stringMatching(/1 subagent or other background task/)])
  })

  it('starts beside a long-lived command, and a turn that starts cuts it cleanly', async () => {
    const { dream, opened } = waitingDream()
    claude.capabilities.dream = dream
    sdk.state.turn = () => devServer('b2')
    await runTurn(TASK, 'restart the dev server')
    await waitIdle(TASK)
    expect((await send<DreamRun>('POST', `/tasks/${TASK}/dream`)).status).toBe(200)
    await opened
    sdk.state.turn = () => []
    await runTurn(TASK, 'the dev server printed an error')
    const run = await ended()
    expect(run).toMatchObject({ state: 'cut', reason: 'The agent started a turn.', memory_changes: 1 })
    expect(run.report?.summary).toBe('Noted the dev server')
    expect(fs.readFileSync(path.join(claudeMemory(CWD), 'MEMORY.md'), 'utf8')).toContain('5173')
    const events = (await send<AuditPage>('GET', '/audit?area=dream&limit=50')).data.events
    const kinds = events.filter((event) => event.subject_id === TASK).map((event) => event.kind)
    expect(kinds.toReversed()).toEqual(['dream.started', 'dream.memory_changed', 'dream.ended'])
  })
})
