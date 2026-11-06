import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  auditQuery,
  type ContextPackSummary,
  type Repo,
  type Task,
  type TaskAccessView,
  type UserSettings,
} from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { repos } from './db.js'
import { setPlannerModel, type PlannerRequest } from './planner.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const fake = new fakes.FakeSdk(async function* () {
    await Promise.resolve()
    yield fakes.fakeMessage('system', {
      subtype: 'init',
      session_id: 'planned',
      model: 'haiku',
      permissionMode: 'default',
    })
    yield fakes.fakeResult()
  })
  return { query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()

interface Reply<T> {
  status: number
  data: T
  error: { detail?: string } | undefined
}

async function send<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  body?: unknown,
  auth = USER_AUTH,
): Promise<Reply<T>> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as { data: T; error?: { detail?: string } }
  const created = json.data as { id?: unknown; status?: unknown } | undefined
  if (method === 'POST' && res.status === 200 && typeof created?.id === 'string') {
    await waitIdle(created.id)
  }
  return { status: res.status, data: json.data, error: json.error }
}

async function checkout(slug: string): Promise<Repo> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `seti-agent-start-${slug.replace('/', '-')}-`))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Title\n\n![badge](x)\nBilling service for invoices.\n')
  const repo: Repo = { id: crypto.randomUUID(), slug, path: dir, base_branch: 'main', created_at: '2026-01-01' }
  await repos.insert(repo)
  return repo
}

const billing = await checkout('acme/billing')
const requests: PlannerRequest[] = []

function answer(reply: Record<string, unknown>): void {
  setPlannerModel(async (request) => {
    requests.push(request)
    return Promise.resolve(reply)
  })
}

afterEach(() => {
  requests.length = 0
  setPlannerModel(async () => Promise.reject(new Error('no model in tests')))
})

describe('POST /api/tasks/start', () => {
  it('creates the agent the planner set up, sandboxed, and records the plan', async () => {
    answer({ title: 'Fix invoice rounding', repos: ['acme/billing'], worktree: false, aws: true, role: 'Lead' })
    const { status, data: task } = await send<Task>('POST', '/tasks/start', {
      prompt: 'The invoices round the wrong way, fix it',
    })
    expect(status).toBe(200)
    expect(requests[0]?.prompt).toContain('- acme/billing: Billing service for invoices.')
    expect(task).toMatchObject({ title: 'Fix invoice rounding', cwd: billing.path, sandbox: true })
    const packs = (await send<ContextPackSummary[]>('GET', `/tasks/${task.id}/context-packs`)).data
    expect(packs.filter((pack) => pack.kind === 'role')).toEqual([])
    expect(task.setup).toMatchObject({
      planner: 'model',
      repos: ['acme/billing'],
      worktree: false,
      access: [],
      withheld: ['AWS: not configured'],
    })
    const [created] = (await auditEvents.page(auditQuery.parse({ kind: 'task.created', limit: 1 }))).events
    expect(created?.subject_id).toBe(task.id)
    expect(created?.summary).toContain('planned: repo acme/billing')
    expect(created?.detail).toMatchObject({ planner: 'model', withheld: ['AWS: not configured'] })
  })

  it('falls back to a titled agent in a fresh folder when the planner fails', async () => {
    const { data: task } = await send<Task>('POST', '/tasks/start', { prompt: 'sketch a logo idea\nin blue' })
    expect(task.title).toBe('Sketch a logo idea')
    expect(task.repos).toEqual([])
    expect(task.setup).toMatchObject({ planner: 'fallback', fallback_reason: 'no model in tests' })
  })

  it('keeps what the caller pinned and still plans the rest', async () => {
    answer({ title: 'Model title', repos: [] })
    const { data: task } = await send<Task>('POST', '/tasks/start', {
      prompt: 'review it',
      title: 'Review PR 7',
      repo_ids: [billing.id],
      worktree: false,
    })
    expect(task).toMatchObject({ title: 'Review PR 7', repo_id: billing.id })
  })

  it('grants an SSH host the message names through the agent access', async () => {
    const { data: key } = await send<{ id: string }>('POST', '/ssh/keys', { name: 'start' })
    const host = { alias: 'k8s', hostname: '192.0.2.9', user: 'ops', key_id: key.id }
    expect((await send('POST', '/ssh/hosts', host)).status).toBe(200)
    answer({ title: 'Restart the pod', ssh_hosts: ['k8s'] })
    const { data: task } = await send<Task>('POST', '/tasks/start', { prompt: 'ssh to k8s and restart the pod' })
    expect(task.setup?.access).toEqual(['SSH k8s'])
    const { data: view } = await send<TaskAccessView>('GET', `/tasks/${task.id}/access`)
    expect(view.items.find((item) => item.kind === 'ssh' && item.id === 'k8s')).toMatchObject({
      enabled: true,
      override: true,
      default_enabled: false,
    })
  })

  it('never grants the EA SSH or AWS', async () => {
    answer({ title: 'Check AWS', aws: true, ssh_hosts: ['k8s'] })
    const { data: task } = await send<Task>('POST', '/tasks/start', { prompt: 'ssh to k8s and check aws' }, EA_AUTH)
    expect(task.sandbox).toBe(true)
    expect(task.setup?.withheld).toEqual(['SSH k8s: the EA cannot grant it', 'AWS: the EA cannot grant it'])
    const { data: view } = await send<TaskAccessView>('GET', `/tasks/${task.id}/access`)
    expect(view.items.filter((item) => item.enabled && (item.kind === 'ssh' || item.kind === 'aws'))).toEqual([])
  })

  it('refuses an empty message', async () => {
    const { status, error } = await send('POST', '/tasks/start', { prompt: '  ' })
    expect(status).toBe(400)
    expect(error?.detail).toContain('Type what the agent should do')
  })
})

describe('POST /api/tasks without a title', () => {
  it('titles the agent with the planner and keeps the rest as sent', async () => {
    answer({ title: 'Tidy the changelog', repos: ['acme/other'] })
    const { data: task } = await send<Task>('POST', '/tasks', { prompt: 'tidy up CHANGELOG.md please' })
    expect(task.title).toBe('Tidy the changelog')
    expect(task.repos).toEqual([])
    expect(task.setup).toBeNull()
    expect(requests[0]?.prompt).not.toContain('acme/billing')
  })
})

describe('/api/user', () => {
  it('starts with a name and saves a new one', async () => {
    const gitconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-gitconfig-')), 'config')
    fs.writeFileSync(gitconfig, '[user]\n\tname = Sam Example\n')
    vi.stubEnv('GIT_CONFIG_GLOBAL', gitconfig)
    const first = await send<UserSettings>('GET', '/user')
    vi.unstubAllEnvs()
    fs.rmSync(path.dirname(gitconfig), { recursive: true, force: true })
    expect(first.data).toEqual({ name: 'Sam', theme: null })
    expect((await send('PUT', '/user', { name: ' ' })).status).toBe(400)
    expect((await send<UserSettings>('PUT', '/user', { name: 'Ada' })).data).toEqual({ name: 'Ada', theme: null })
    expect((await send<UserSettings>('GET', '/user')).data).toEqual({ name: 'Ada', theme: null })
  })

  it("keeps a theme Seti or a mod has for every device, the mod's even while it is off", async () => {
    const theme = { id: 'catppuccin.catppuccin', flavour: 'frappe', accent: 'teal' }
    expect((await send<UserSettings>('PUT', '/user', { theme })).data.theme).toEqual(theme)
    expect((await send('PATCH', '/mods/catppuccin', { enabled: false })).status).toBe(200)
    expect((await send<UserSettings>('GET', '/user')).data.theme).toEqual(theme)
    expect((await send('PATCH', '/mods/catppuccin', { enabled: true })).status).toBe(200)
    const unknown = await send('PUT', '/user', { theme: { ...theme, id: 'nothing.here' } })
    expect(unknown.status).toBe(400)
    expect((await send('PUT', '/user', { theme: { ...theme, flavour: 'Not An Id' } })).status).toBe(400)
    const back = { id: 'default', flavour: 'frappe', accent: 'teal' }
    expect((await send<UserSettings>('PUT', '/user', { theme: back })).data).toMatchObject({ theme: back })
    const { events } = await auditEvents.page(auditQuery.parse({ kind: 'system.theme_changed' }))
    expect(events.map((event) => event.summary)).toContain('Changed the theme to Catppuccin')
  })
})
