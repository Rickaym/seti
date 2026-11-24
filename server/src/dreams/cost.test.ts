import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AuditPage, DreamRun } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { findBinary } from '../binaries.js'
import { tasks } from '../db.js'
import type { DreamHost, DreamSession, DreamSupport, SessionReport } from '../runtimes/adapter.js'
import { reportedCost } from '../runtimes/claude/cost.js'
import { claudeMemory } from '../runtimes/claude/dream.js'
import { claudeSession } from '../runtimes/claude/session.js'
import { adapterFor } from '../runtimes/registry.js'
import { nightRuns } from '../store/dream-nights.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { USER_AUTH } from '../test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-dc-'))
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
const claude = adapterFor('claude')
const real = claude.capabilities.dream

afterAll(() => {
  claude.capabilities.dream = real
  fs.rmSync(scratch, { recursive: true, force: true })
})

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = (await res.json()) as { data?: T; error?: { detail: string } }
  return { status: res.status, data: (parsed.data ?? parsed.error?.detail ?? null) as T }
}

/** What Claude Code's SDK sends for a dream: a report through the dream server, then its result. */
function claudeTransport(result: Partial<SDKMessage>): (host: DreamHost) => Query {
  return (host) => {
    async function* messages(): AsyncGenerator<SDKMessage> {
      await host.tools[0]?.call({ summary: 'Kept one rule' })
      const base = { session_id: 's', uuid: randomUUID(), num_turns: 3, duration_ms: 900, is_error: false }
      yield await Promise.resolve({
        ...base,
        type: 'result',
        subtype: 'success',
        result: 'done',
        ...result,
      } as SDKMessage)
    }
    const query = Object.assign(messages(), { interrupt: async () => Promise.resolve(), close: () => undefined })
    return query as unknown as Query
  }
}

/** The Claude adapter's dream with the SDK replaced by `transport`: the real projection and cost. */
const claudeDream = (transport: (host: DreamHost) => Query): DreamSupport => ({
  memory: claudeMemory,
  reportedCost,
  open: async (_spec, _launcher, host) => Promise.resolve(claudeSession(transport(host), false)),
})

/** A runtime that reports what it spent so far and keeps going until Seti interrupts it. */
function overspending(spent: number): { dream: DreamSupport; interrupted: () => boolean } {
  let stopped = false
  let wake: () => void = () => undefined
  const asleep = new Promise<void>((resolve) => {
    wake = resolve
  })
  const report: SessionReport = {
    type: 'message',
    raw: { spent },
    work: true,
    byAgent: true,
    delivered: [],
    events: [],
  }
  const session: DreamSession = {
    events: (async function* () {
      yield await Promise.resolve(report)
      await asleep
    })(),
    interrupt: async () => {
      stopped = true
      wake()
      return Promise.resolve()
    },
    close: () => {
      wake()
    },
  }
  const dream: DreamSupport = {
    memory: claudeMemory,
    reportedCost: (raw) => (typeof raw === 'object' && raw !== null && 'spent' in raw ? Number(raw.spent) : null),
    open: async () => Promise.resolve(session),
  }
  return { dream, interrupted: () => stopped }
}

async function agent(): Promise<string> {
  const id = randomUUID()
  const cwd = path.join(scratch, 'work', id)
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(claudeMemory(cwd), { recursive: true })
  fs.writeFileSync(path.join(claudeMemory(cwd), 'MEMORY.md'), '- old note\n')
  await tasks.insert({ id, title: 'Lead', repo_id: null, cwd, worktree: false, pr_urls: [], sandbox: true })
  return id
}

async function dreamOf(id: string): Promise<DreamRun> {
  expect((await send<DreamRun>('POST', `/tasks/${id}/dream`, {})).status).toBe(200)
  return vi.waitFor(
    async () => {
      const [run] = (await send<DreamRun[]>('GET', `/tasks/${id}/dreams`)).data
      if (run === undefined || run.state === 'running') {
        throw new Error('still dreaming')
      }
      return run
    },
    { timeout: 15_000, interval: 100 },
  )
}

describe.skipIf(!bwrap)("a dream's cost", () => {
  it("records what Claude Code's result reports for the dream, in the run and its audit", async () => {
    await sandboxPolicy.save({ enabled: true, allowed_domains: [], hidden_paths: [] })
    claude.capabilities.dream = claudeDream(claudeTransport({ total_cost_usd: 0.37 }))
    const id = await agent()
    const run = await dreamOf(id)
    expect(run).toMatchObject({ state: 'done', cost_usd: 0.37 })
    await vi.waitFor(async () => {
      const audit = await send<AuditPage>('GET', '/audit?area=dream&limit=50')
      const ended = audit.data.events.find((e) => e.kind === 'dream.ended' && e.subject_id === id)
      expect(ended?.detail).toMatchObject({ cost_usd: 0.37 })
    })
  })

  it('records a dream Claude Code stopped at its budget as stopped, with what it spent', async () => {
    claude.capabilities.dream = claudeDream(
      claudeTransport({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1.02 }),
    )
    const run = await dreamOf(await agent())
    expect(run).toMatchObject({ state: 'stopped', reason: 'It reached its budget.', cost_usd: 1.02 })
  })

  it('stops a dream whose runtime reports spending past its budget and lets it go on', async () => {
    const { dream, interrupted } = overspending(1.4)
    claude.capabilities.dream = dream
    const run = await dreamOf(await agent())
    expect(run).toMatchObject({ state: 'stopped', reason: 'It reached its budget.', cost_usd: 1.4 })
    expect(interrupted()).toBe(true)
  })

  it("refuses Dream now once the night's recorded dreams leave no room in its budget", async () => {
    claude.capabilities.dream = claudeDream(claudeTransport({ total_cost_usd: 0.5 }))
    const run = await dreamOf(await agent())
    const spent = await nightRuns.cost(run.night)
    expect(spent).toBeGreaterThanOrEqual(0.5)
    const saved = await send('PUT', '/dreams/settings', { dream_budget_usd: 1, night_budget_usd: spent + 0.5 })
    expect(saved.status).toBe(200)
    const refused = await send<string>('POST', `/tasks/${await agent()}/dream`, {})
    expect([refused.status, refused.data]).toEqual([409, expect.stringMatching(/night's dream budget is spent/)])
  })
})
