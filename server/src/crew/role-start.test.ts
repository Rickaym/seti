import { auditQuery, type ContextPack, type StartAgentRequest, type Task } from '@seti/shared'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import type * as CodexStatus from '../codex-status.js'
import { tasks } from '../db.js'
import { setPlannerModel } from '../planner.js'
import { packForTask } from '../seti-guide.js'
import { auditEvents } from '../store/audit.js'
import { contextPacks, packsOfTask } from '../store/context.js'
import { USER_AUTH } from '../test-auth.js'
import { waitIdle } from '../wait-idle.js'
import { roleStart } from './role-start.js'

const codex = vi.hoisted(() => ({ ready: false }))

vi.mock('../codex-status.js', async (importOriginal) => {
  const real = await importOriginal<typeof CodexStatus>()
  return {
    ...real,
    requireRuntime: async (runtime: string, profileId: string) =>
      runtime === 'codex' && codex.ready ? undefined : real.requireRuntime(runtime as 'codex', profileId),
  }
})

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('../fake-sdk.js')
  return new FakeSdk(function* () {
    yield fakeAssistant('Reviewed.')
    yield fakeResult()
  })
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
let reviewerId = ''

interface Reply<T> {
  status: number
  data: T
}

async function send<T = unknown>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
  const response = await app.request(`/api${path}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await response.json()) as { data: T }
  return { status: response.status, data: json.data }
}

async function startIn(body: Record<string, unknown>): Promise<Task> {
  setPlannerModel(async () => Promise.resolve({ title: 'Review' }))
  const { status, data } = await send<Task>('POST', '/tasks/start', { prompt: 'review PR 12', ...body })
  expect(status).toBe(200)
  await waitIdle(data.id)
  return data
}

const request = (extra: Partial<StartAgentRequest>): StartAgentRequest => ({
  prompt: 'review',
  sandbox: true,
  notify_when_done: false,
  attachments: [],
  ...extra,
})

describe('a start naming a role no pack has', () => {
  it('is refused with the roles there are, none on a fresh install', async () => {
    expect((await contextPacks.list()).filter((pack) => pack.kind === 'role')).toEqual([])
    await expect(roleStart(request({ role: 'Reviewer' }), 'default')).rejects.toThrow(
      'No role is named Reviewer, and there are no roles yet',
    )
    const own = await contextPacks.create({ name: 'Release lead', description: '', body: 'Ship it.' }, 'role')
    await expect(roleStart(request({ role: 'Nobody' }), 'default')).rejects.toThrow(
      'No role is named Nobody; the roles are Release lead',
    )
    await contextPacks.remove(own.id)
  })
})

describe("a role's runtime and model", () => {
  beforeAll(async () => {
    const fields = { name: 'Reviewer', description: '', body: 'Reviewer: you review PRs.' }
    reviewerId = (await contextPacks.create(fields, 'role')).id
  })

  it('are set on a role, audited, and refused on a reference pack', async () => {
    const set = await send<ContextPack>('PUT', `/context/packs/${reviewerId}/runtime`, {
      runtime: null,
      model: 'gpt-5.5',
    })
    expect(set.data).toMatchObject({ runtime: 'codex', model: 'gpt-5.5' })
    const { events } = await auditEvents.page(auditQuery.parse({ kind: 'context.pack_runtime_changed', limit: 1 }))
    expect(events[0]?.detail).toMatchObject({ name: 'Reviewer', runtime: 'codex', model: 'gpt-5.5' })
    const guide = (await send<ContextPack[]>('GET', '/context/packs')).data.find((pack) => pack.name === 'Seti guide')
    expect(
      (await send('PUT', `/context/packs/${guide?.id ?? ''}/runtime`, { runtime: 'codex', model: null })).status,
    ).toBe(400)
    expect(
      (await send('PUT', `/context/packs/${reviewerId}/runtime`, { runtime: 'claude', model: 'gpt-5.5' })).status,
    ).toBe(400)
  })

  it("apply where the start names neither, and the start's own picks win", async () => {
    codex.ready = true
    await send('PUT', `/context/packs/${reviewerId}/runtime`, { runtime: 'codex', model: 'gpt-5.5' })
    expect(await roleStart(request({ role: 'reviewer' }), 'default')).toMatchObject({
      runtime: 'codex',
      model: 'gpt-5.5',
      held: [],
    })
    expect(await roleStart(request({ role: 'Reviewer', model: 'opus' }), 'default')).toMatchObject({
      runtime: undefined,
      model: 'opus',
    })
    codex.ready = false
  })

  it("fall back to the default with a setup note while the role's runtime cannot start, and link the role", async () => {
    await send('PUT', `/context/packs/${reviewerId}/runtime`, { runtime: 'codex', model: 'gpt-5.5' })
    const task = await startIn({ role: 'Reviewer' })
    expect(task.runtime).toBe('claude')
    expect(task.setup?.withheld.join(' ')).toContain('Codex for the Reviewer role')
    expect((await packsOfTask(task.id)).filter((pack) => pack.kind === 'role').map((pack) => pack.name)).toEqual([
      'Reviewer',
    ])
    await send('PUT', `/context/packs/${reviewerId}/runtime`, { runtime: null, model: null })
  })
})

describe('the guide per runtime', () => {
  it('sends an agent whose runtime has no subagents to helpers instead of the Agent tool', async () => {
    const guide = (await contextPacks.list()).find((pack) => pack.name === 'Seti guide')
    for (const runtime of ['claude', 'codex'] as const) {
      const id = `role-runtime-${runtime}`
      await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [], runtime })
      const head = guide === undefined ? '' : (await packForTask(guide, id)).body
      expect(head.includes('Agent tool')).toBe(runtime === 'claude')
      expect(head.includes('hand one to a helper agent')).toBe(runtime === 'codex')
    }
  })
})
