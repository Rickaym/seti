import fs from 'node:fs'
import path from 'node:path'
import {
  disposeAll,
  type AuditEvent,
  type AuditKind,
  type AuditPage,
  type AuditStatus,
  type CapabilitiesSnapshot,
  type ContextPack,
  type Disposer,
  type PreviewRequest,
  type Repo,
  type Task,
} from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { auditHealthChange } from './account.js'
import { createApp } from './app.js'
import type * as Capabilities from './capabilities.js'
import { prDecorators } from './pr-decorators.js'
import type * as Prs from './prs.js'
import { USER_AUTH } from './test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdirSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-audit-routes-test-'))
  mkdirSync(nodePath.join(root, 'checkout', '.git'), { recursive: true })
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const signIn = vi.hoisted(() => ({ fail: false }))
const preview = vi.hoisted(() => ({ relabeled: false }))

vi.mock('./runner.js', () => ({
  runTurn: (_id: string, _prompt: string, options?: { interrupt?: boolean }) => options?.interrupt === true,
  stopTurn: async () => Promise.resolve(),
  endSession: async () => Promise.resolve(),
  sessionState: () => ({ open: true, background: 1 }),
  isRunning: () => false,
  registerContextProvider: () => undefined,
  registerSessionMcpServers: () => undefined,
  registerTurnPreface: () => undefined,
  onTurnEnd: () => undefined,
  subscribe: () => () => undefined,
}))

vi.mock('./mcp-config.js', () => ({
  mcpConfig: {
    add: async (input: { name: string; scope: string }) => Promise.resolve({ name: input.name, scope: input.scope }),
    remove: async (name: string, scope: string) => Promise.resolve({ name, scope }),
  },
}))

vi.mock('./mcp-auth.js', () => ({
  mcpAuth: {
    start: async () =>
      Promise.resolve({
        session_id: 's1',
        authorization_url: 'https://auth.example/authorize?state=abc',
        callback_expected: true,
      }),
    complete: async () => {
      if (signIn.fail) {
        throw new Error('That does not look like a redirect URL')
      }
      return Promise.resolve({ server: 'linear' })
    },
    cancel: (id: string) => id === 's1',
    serverOf: (id: string) => (id === 's1' ? 'linear' : null),
  },
}))

vi.mock('./capabilities.js', async (importOriginal) => {
  const original = await importOriginal<typeof Capabilities>()
  const snapshot = {
    cwd: '/home/me',
    servers: [
      {
        name: 'linear',
        status: 'needs-auth',
        scope: 'user',
        transport: { type: 'http', target: 'https://mcp.linear.app/mcp' },
        tools: [],
      },
    ],
  } as unknown as CapabilitiesSnapshot
  return {
    ...original,
    capabilityCache: { ...original.capabilityCache, refresh: async () => Promise.resolve(snapshot) },
  }
})

vi.mock('./prs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Prs>()),
  redeployPreview: async () => Promise.resolve(preview.relabeled),
}))

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()
const checkout = path.join(scratch, 'checkout')

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

async function latest(kind: AuditKind): Promise<AuditEvent | undefined> {
  const res = await send<AuditPage>('GET', `/audit?kind=${kind}&limit=1`)
  return res.data.events[0]
}

async function kindsSince(id: number): Promise<AuditEvent['kind'][]> {
  const res = await send<AuditPage>('GET', '/audit?limit=200')
  return res.data.events
    .filter((e) => e.id > id)
    .map((e) => e.kind)
    .reverse()
}

async function lastId(): Promise<number> {
  return (await send<AuditPage>('GET', '/audit?limit=1')).data.events[0]?.id ?? 0
}

describe('audit API', () => {
  it('rejects unknown kinds and oversized pages', async () => {
    expect((await send('GET', '/audit?kind=nope')).status).toBe(400)
    expect((await send('GET', '/audit?limit=500')).status).toBe(400)
    expect((await send('GET', '/audit?actor=robot')).status).toBe(400)
  })

  it('reports retention and an intact chain up to the newest event', async () => {
    await send('POST', '/context/packs', { name: 'Chained pack', body: 'Notes' })
    const { status, data } = await send<AuditStatus>('GET', '/audit/status')
    expect(status).toBe(200)
    expect(data.retention_days).toBe(365)
    expect(data.chain).toMatchObject({ ok: true, head_id: await lastId(), broken_at: null, problem: null })
    expect(data.chain.head_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('repo routes', () => {
  it('record added, updated and removed', async () => {
    const start = await lastId()
    const created = await send<Repo>('POST', '/repos', { slug: 'acme/app', path: checkout, base_branch: 'main' })
    expect(await latest('repo.added')).toMatchObject({
      actor: 'user',
      subject_type: 'repo',
      subject_id: created.data.id,
      summary: 'Added repo acme/app',
    })
    await send('PUT', `/repos/${created.data.id}`, { slug: 'acme/app', path: checkout, base_branch: 'dev' })
    expect((await latest('repo.updated'))?.detail).toMatchObject({ base_branch: 'dev' })
    await send('DELETE', `/repos/${created.data.id}`)
    await send('DELETE', `/repos/${created.data.id}`)
    expect(await kindsSince(start)).toEqual(['repo.added', 'repo.updated', 'repo.removed'])
  })
})

describe('context routes', () => {
  it('record file saves without content and pack changes', async () => {
    const start = await lastId()
    await send('PUT', '/context/files/user', { content: 'secret rules', base_hash: null })
    const saved = await latest('context.file_saved')
    expect(saved?.detail).toEqual({ key: 'user', path: path.join(scratch, 'claude', 'CLAUDE.md'), bytes: 13 })
    expect(JSON.stringify(saved)).not.toContain('secret rules')

    const pack = await send<ContextPack>('POST', '/context/packs', { name: 'Style', body: 'Be brief.' })
    await send('PUT', `/context/packs/${pack.data.id}`, { name: 'Style guide', body: 'Be brief.' })
    await send('DELETE', `/context/packs/${pack.data.id}`)
    expect(await kindsSince(start)).toEqual([
      'context.file_saved',
      'context.pack_created',
      'context.pack_updated',
      'context.pack_deleted',
    ])
    expect((await latest('context.pack_deleted'))?.summary).toBe('Deleted context pack "Style guide"')
  })
})

describe('task routes', () => {
  it('record create, message, stop, PR link, packs and delete', async () => {
    const start = await lastId()
    const pack = await send<ContextPack>('POST', '/context/packs', { name: 'Ops', body: 'x' })
    const first = 'https://github.com/acme/app/pull/3'
    const second = 'https://github.com/acme/api/pull/8'
    const task = await send<Task>('POST', '/tasks', {
      title: 'Fix login',
      prompt: 'Go',
      cwd: scratch,
      context_pack_ids: [pack.data.id],
      pr_urls: [first],
    })
    expect(await latest('task.created')).toMatchObject({
      actor: 'user',
      subject_id: task.data.id,
      summary: `Created task "Fix login" in ${scratch}`,
      detail: {
        title: 'Fix login',
        repo: null,
        cwd: scratch,
        worktree: false,
        context_packs: ['Ops'],
        pr_urls: [first],
      },
    })
    const id = task.data.id
    await send('POST', `/tasks/${id}/messages`, { prompt: 'Also deploy with token=abc123' })
    expect((await latest('task.message_sent'))?.detail.prompt).toBe('Also deploy with token=[redacted]')
    await send('POST', `/tasks/${id}/messages`, { prompt: 'Stop, deploy staging instead', interrupt: true })
    expect(await latest('task.message_sent')).toMatchObject({
      summary: 'Interrupted the agent with a message to task "Fix login"',
      detail: { prompt: 'Stop, deploy staging instead', interrupted: true },
    })
    await send('POST', `/tasks/${id}/stop`)
    expect((await send('POST', `/tasks/${id}/session/end`)).status).toBe(200)
    expect(await latest('task.session_ended')).toMatchObject({
      summary: 'Stopped all background work of task "Fix login"',
    })
    expect((await send<Task>('POST', `/tasks/${id}/prs`, { url: second })).data.pr_urls).toEqual([first, second])
    expect((await send<Task>('POST', `/tasks/${id}/prs`, { url: second })).data.pr_urls).toEqual([first, second])
    expect((await send('POST', `/tasks/${id}/prs`, { url: 'https://github.com/acme/app/issues/3' })).status).toBe(400)
    expect(await latest('task.pr_linked')).toMatchObject({
      actor: 'user',
      summary: 'Linked PR acme/api#8',
      detail: { url: second },
    })
    await send('PATCH', `/tasks/${id}`, { title: 'Renamed' })
    const unlinked = await send<Task>('DELETE', `/tasks/${id}/prs?url=${encodeURIComponent(first)}`)
    expect(unlinked.data.pr_urls).toEqual([second])
    expect((await send('DELETE', `/tasks/${id}/prs?url=${encodeURIComponent(first)}`)).status).toBe(404)
    await send('PUT', `/tasks/${id}/context-packs`, { pack_ids: [] })
    await send('PUT', `/tasks/${id}/context-packs`, { pack_ids: [] })
    await send('DELETE', `/tasks/${id}`)
    expect(await kindsSince(start)).toEqual([
      'context.pack_created',
      'task.created',
      'task.message_sent',
      'task.message_sent',
      'task.stopped',
      'task.session_ended',
      'task.pr_linked',
      'task.renamed',
      'task.pr_unlinked',
      'task.context_packs_changed',
      'task.deleted',
    ])
    expect(await latest('task.renamed')).toMatchObject({
      summary: 'Renamed task "Fix login" to "Renamed"',
      detail: { title: 'Renamed', previous_title: 'Fix login' },
    })
    expect(await latest('task.context_packs_changed')).toMatchObject({ detail: { before: ['Ops'], after: [] } })
  })
})

describe('mcp routes', () => {
  it('record server changes without header values', async () => {
    const start = await lastId()
    await send('POST', '/mcp/servers', {
      name: 'linear',
      scope: 'user',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: [{ key: 'Authorization', value: 'Bearer supersecretvalue' }],
    })
    const added = await latest('mcp.server_added')
    expect(added).toMatchObject({ detail: { server: 'linear', scope: 'user', transport: 'http' } })
    expect(JSON.stringify(added)).not.toMatch(/supersecret|mcp\.linear\.app/)
    await send('DELETE', '/mcp/servers/linear?scope=user')
    await send('POST', '/mcp/linear/reconnect', {})
    expect(await kindsSince(start)).toEqual(['mcp.server_added', 'mcp.server_removed', 'mcp.server_reconnected'])
  })

  it('record sign-in start, completion, failure and cancel without URLs or codes', async () => {
    const start = await lastId()
    await send('POST', '/mcp/linear/auth/start', {})
    const callback = { callback_url: 'http://localhost:3000/callback?code=topsecret&state=abc' }
    await send('POST', '/mcp/auth/s1/complete', callback)
    signIn.fail = true
    await send('POST', '/mcp/auth/s1/complete', callback)
    signIn.fail = false
    await send('DELETE', '/mcp/auth/s1')
    expect(await kindsSince(start)).toEqual([
      'mcp.signin_started',
      'mcp.signin_completed',
      'mcp.signin_failed',
      'mcp.signin_cancelled',
    ])
    const events = await send<AuditPage>('GET', '/audit?kind=mcp&limit=10')
    expect(JSON.stringify(events.data)).not.toMatch(/topsecret|auth\.example|authorize/)
    expect(await latest('mcp.signin_failed')).toMatchObject({ subject_id: 'linear' })
  })
})

describe('pull request routes', () => {
  const previews: Disposer[] = []

  it('refuse a preview label request while no mod fills in previews', async () => {
    const res = await send<PreviewRequest>('POST', '/prs/acme/app/7/redeploy')
    expect(res.status).toBe(409)
    previews.push(prDecorators.register({ key: 'test.preview', decorate: () => ({}) }))
  })

  it('record a preview label request', async () => {
    preview.relabeled = false
    const res = await send<PreviewRequest>('POST', '/prs/acme/app/7/redeploy')
    expect(res.data).toEqual({ label: 'preview', relabeled: false })
    expect(await latest('pr.redeploy_requested')).toMatchObject({
      subject_type: 'pr',
      subject_id: 'app-7',
      summary: 'Added the preview label to acme/app#7 to deploy its preview',
      detail: { repo: 'acme/app', number: 7, label: 'preview', label_change: 'added' },
    })
  })

  it('record a preview label that was removed and added again', async () => {
    preview.relabeled = true
    const res = await send<PreviewRequest>('POST', '/prs/acme/app/8/redeploy')
    expect(res.data).toEqual({ label: 'preview', relabeled: true })
    expect(await latest('pr.redeploy_requested')).toMatchObject({
      subject_id: 'app-8',
      summary: 'Removed and re-added the preview label on acme/app#8 to redeploy its preview',
      detail: { label_change: 'removed and re-added' },
    })
    disposeAll(previews)
  })
})

describe('account health', () => {
  it('records only changes of the health state', async () => {
    const start = await lastId()
    await auditHealthChange({ state: 'ok', message: 'fine' })
    await auditHealthChange({ state: 'ok', message: 'still fine' })
    await auditHealthChange({ state: 'logged_out', message: 'gone' })
    expect(await kindsSince(start)).toEqual(['account.health_changed', 'account.health_changed'])
    expect(await latest('account.health_changed')).toMatchObject({
      actor: 'system',
      summary: 'Login health ok to logged_out',
      detail: { from: 'ok', to: 'logged_out' },
    })
  })
})
