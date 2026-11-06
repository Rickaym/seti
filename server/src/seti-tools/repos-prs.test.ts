import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PrList, PullRequest, Repo, Task } from '@seti/shared'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { repos, tasks } from '../db.js'
import { setPlannerModel } from '../planner.js'
import { prDecorators } from '../pr-decorators.js'
import type * as Prs from '../prs.js'
import { SETI_TOOLS } from './catalog.js'
import { accessDefaults, taskAccess } from '../store/access.js'
import { auditEvents } from '../store/audit.js'
import { sshHostStore } from '../store/ssh.js'
import { waitIdle } from '../wait-idle.js'
import { callSetiTool } from './server.js'

const sdk = await vi.hoisted(async () => {
  const fakes = await import('../fake-sdk.js')
  const fake = new fakes.FakeSdk(function* () {
    yield fakes.fakeResult()
  })
  return { query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const github = vi.hoisted(() => ({ list: null as PrList | null, relabeled: [] as string[] }))

vi.mock('../prs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Prs>()),
  listPrs: async () => Promise.resolve(github.list),
  findPr: async () => Promise.resolve(null),
  redeployPreview: async (owner: string, name: string, number: number) => {
    github.relabeled.push(`${owner}/${name}#${String(number)}`)
    return Promise.resolve(false)
  },
}))

vi.mock('../git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createWorktree: async () => Promise.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-tools-worktree-'))),
  removeWorktree: async () => Promise.resolve(),
}))

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `seti-tools-${name}-`))

function checkout(slug: string): string {
  const dir = tmp(slug.replace('/', '-'))
  fs.mkdirSync(path.join(dir, '.git'))
  return dir
}

let count = 0

async function newCaller(): Promise<Task> {
  const id = `seti-tools-caller-${String(++count)}`
  await tasks.insert({
    id,
    title: `Caller ${String(count)}`,
    repo_id: null,
    cwd: tmp('caller'),
    worktree: false,
    pr_urls: [],
    seti_control: 'full',
  })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('caller not stored')
  }
  return task
}

async function call(caller: Task, name: string, args: unknown = {}) {
  const entry = SETI_TOOLS.find((candidate) => candidate.name === name)
  if (entry === undefined) {
    throw new Error(`no tool ${name}`)
  }
  const result = await callSetiTool(entry, caller.id, args)
  const text = result.content.map((block) => block.text).join('')
  return { error: result.isError === true, text, data: () => JSON.parse(text) as unknown }
}

beforeAll(() => {
  setPlannerModel(async () => Promise.reject(new Error('no model in tests')))
})

describe('repo tools', () => {
  it('adds, changes, reads the warm caches of and removes a repo', async () => {
    const caller = await newCaller()
    const added = await call(caller, 'add_repo', {
      slug: 'acme/tools',
      path: checkout('acme/tools'),
      base_branch: 'main',
    })
    expect(added.error).toBe(false)
    expect((await call(caller, 'list_repos')).text).toContain('acme/tools')
    const updated = await call(caller, 'update_repo', { repo: 'acme/tools', base_branch: 'develop' })
    expect(updated.data()).toMatchObject({ slug: 'acme/tools', base_branch: 'develop' })
    expect((await call(caller, 'update_repo', { repo: 'tools', base_branch: 'develop' })).text).toContain(
      'changes nothing',
    )
    const caches = await call(caller, 'set_warm_caches', { repo: 'acme/tools', enabled: false, max_mb: 64 })
    expect(caches.data()).toMatchObject({ settings: { enabled: false, max_mb: 64 } })
    expect((await call(caller, 'get_warm_caches', { repo: 'acme/tools' })).data()).toMatchObject({
      settings: { enabled: false },
    })
    expect((await call(caller, 'remove_repo', { repo: 'acme/tools' })).error).toBe(false)
    expect((await repos.list()).some((repo) => repo.slug === 'acme/tools')).toBe(false)
    const audited = await auditEvents.page({ kind: 'repo.added', limit: 5 })
    expect(audited.events[0]).toMatchObject({ actor: 'agent', detail: { agent_id: caller.id } })
  })
})

describe('PR tools', () => {
  const repo: Repo = {
    id: crypto.randomUUID(),
    slug: 'acme/web',
    path: '',
    base_branch: 'main',
    created_at: '2026-01-01',
  }
  const pr: PullRequest = {
    key: 'web-7',
    repo_id: repo.id,
    repo_slug: repo.slug,
    number: 7,
    title: 'Fix the login form',
    url: 'https://github.com/acme/web/pull/7',
    draft: false,
    author: 'octo',
    head_ref: 'fix-login',
    base_ref: 'main',
    head_oid: 'abc',
    updated_at: '2026-10-01T00:00:00Z',
    review_decision: null,
    mergeable: 'mergeable',
    labels: [],
    ci: 'failure',
    checks: [{ name: 'lint', state: 'failure', detail: 'bad', url: null }],
    unresolved_threads: 2,
    preview: { state: 'none', url: null, commit: null, stale: false },
    preview_host: null,
    tasks: [],
    related: [],
  }

  beforeAll(async () => {
    repo.path = checkout('acme/web')
    await repos.insert(repo)
    github.list = {
      viewer: 'octo',
      scope: 'all',
      repos: [{ ...repo, repo_id: repo.id, error: null, previews: true, prs: [pr] }],
      previews_on: false,
    }
  })

  it('lists, reads and previews open PRs by number or URL', async () => {
    const caller = await newCaller()
    expect((await call(caller, 'list_prs', { scope: 'all' })).data()).toMatchObject({
      prs: [{ key: 'web-7', ci: 'failure', unresolved_threads: 2 }],
    })
    expect((await call(caller, 'get_pr', { pr: 'web #7' })).data()).toMatchObject({
      unresolved_threads: 2,
      checks: [{ name: 'lint' }],
    })
    expect((await call(caller, 'request_preview', { pr: pr.url })).text).toContain('PR previews are off')
    expect(github.relabeled).toEqual([])
    const dispose = prDecorators.register({ key: 'test.preview', decorate: () => ({}) })
    if (github.list !== null) {
      github.list.previews_on = true
    }
    expect((await call(caller, 'request_preview', { pr: pr.url })).data()).toMatchObject({ relabeled: false })
    dispose()
    expect(github.relabeled).toContain('acme/web#7')
    expect((await call(caller, 'get_pr', { pr: '99' })).text).toContain('No open PR #99')
  })

  it('starts an agent on a PR branch on the caller credentials, with Seti control Self', async () => {
    const caller = await newCaller()
    const started = await call(caller, 'start_agent_from_pr', { pr: 'web-7', instructions: 'Fix lint' })
    expect(started.error).toBe(false)
    const task = await tasks.get((started.data() as { id: string }).id)
    await waitIdle(task?.id ?? '')
    expect(task).toMatchObject({
      sandbox: true,
      seti_control: 'self',
      profile_id: caller.profile_id,
      pr_urls: [pr.url],
    })
  })
})

describe('session import', () => {
  it('refuses when imported agents would get a default-on SSH host the caller has turned off', async () => {
    const caller = await newCaller()
    await sshHostStore.insert('k8s', {
      hostname: '198.51.100.9',
      port: 22,
      user: 'ops',
      key_id: null,
      jump: null,
      options: [],
    })
    await accessDefaults.set('ssh', 'k8s', true)
    await taskAccess.set(caller.id, 'ssh', 'k8s', false)
    const refused = await call(caller, 'import_sessions', { sessions: ['terminal session'] })
    expect(refused.error).toBe(true)
    expect(refused.text).toContain('Imported agents would get more than you have')
    expect(refused.text).toContain('SSH k8s')
    await accessDefaults.set('ssh', 'k8s', false)
  })
})
