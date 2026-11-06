import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { AuditEvent, AuditPage, Repo, Task } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { WORKTREE_ROOT } from './config.js'
import { repos, tasks } from './db.js'
import { taskReposContext } from './tasks.js'
import { USER_AUTH } from './test-auth.js'
import { workspaceDir } from './workspace/dir.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-multi-repo-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const sdk = vi.hoisted(() => ({ calls: [] as { prompt: unknown; options?: Options }[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (params: { prompt: unknown; options?: Options }) => {
    sdk.calls.push(params)
    const session = (async function* () {
      await Promise.resolve()
      yield* []
    })()
    return Object.assign(session, { close: () => undefined })
  },
}))

function git(cwd: string, ...args: string[]): string {
  const identity = ['-c', 'user.name=Seti Test', '-c', 'user.email=test@seti.invalid']
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', [...identity, '-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

/** A checkout whose origin is a local bare repo with main and, when asked, a dev branch. */
async function scratchRepo(name: string, withDev = false): Promise<Repo> {
  const origin = path.join(scratch, `${name}.git`)
  const checkout = path.join(scratch, name)
  fs.mkdirSync(checkout)
  git(scratch, 'init', '--bare', '--initial-branch=main', origin)
  git(checkout, 'init', '--initial-branch=main')
  fs.writeFileSync(path.join(checkout, `${name}.txt`), `${name}\n`)
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'chore: seed')
  git(checkout, 'remote', 'add', 'origin', origin)
  git(checkout, 'push', 'origin', 'main')
  if (withDev) {
    git(checkout, 'checkout', '-b', 'dev')
    git(checkout, 'commit', '--allow-empty', '-m', 'chore: dev only')
    git(checkout, 'push', 'origin', 'dev')
    git(checkout, 'checkout', 'main')
  }
  const repo: Repo = {
    id: crypto.randomUUID(),
    slug: `acme/${name}`,
    path: checkout,
    base_branch: 'main',
    created_at: '2026-01-01',
  }
  await repos.insert(repo)
  return repo
}

const app = createApp()
const api = await scratchRepo('api', true)
const web = await scratchRepo('web')

interface Reply<T> {
  status: number
  body: { data: T; error?: { detail: string } }
}

async function send<T>(method: 'POST' | 'PUT' | 'DELETE' | 'GET', url: string, body?: unknown): Promise<Reply<T>> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Reply<T>['body'] }
}

const createTask = async (body: Record<string, unknown>) =>
  send<Task>('POST', '/tasks', { title: 'Cross repo', prompt: 'List a file from each repo', ...body })

const lastCall = () => sdk.calls.at(-1)?.options

/** Sessions start once the task's GitHub token is looked up, just after the task is created. */
async function started(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(sdk.calls).toHaveLength(count)
  })
}

beforeEach(() => {
  sdk.calls.length = 0
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('tasks on several repos', () => {
  it('creates a worktree per repo, passes the extras to the SDK and removes them all on delete', async () => {
    const { status, body } = await createTask({ repo_ids: [api.id, web.id], worktree: true, ref: 'dev' })
    expect(status).toBe(200)
    const task = body.data
    const [primary, extra] = task.repos
    expect(task.repos.map((repo) => repo.slug)).toEqual(['acme/api', 'acme/web'])
    expect(task).toMatchObject({ repo_id: api.id, repo_slug: 'acme/api', cwd: primary?.dir, worktree: true })
    expect(primary?.dir.startsWith(WORKTREE_ROOT)).toBe(true)
    expect(extra?.dir.startsWith(WORKTREE_ROOT)).toBe(true)
    const primaryDir = primary?.dir ?? ''
    const extraDir = extra?.dir ?? ''
    expect(git(primaryDir, 'rev-parse', 'HEAD')).toBe(git(api.path, 'rev-parse', 'origin/dev'))
    expect(git(extraDir, 'rev-parse', 'HEAD')).toBe(git(web.path, 'rev-parse', 'origin/main'))

    await started(1)
    expect(lastCall()).toMatchObject({ cwd: primaryDir, additionalDirectories: [extraDir, workspaceDir(task.id)] })
    const append = JSON.stringify(lastCall()?.systemPrompt)
    expect(append).toContain(`- acme/api: ${primaryDir} (your working directory)`)
    expect(append).toContain(`- acme/web: ${extraDir}`)

    expect((await send('DELETE', `/tasks/${task.id}`)).status).toBe(204)
    expect(fs.existsSync(primaryDir)).toBe(false)
    expect(fs.existsSync(extraDir)).toBe(false)
    expect(git(api.path, 'worktree', 'list')).not.toContain(primaryDir)
    expect(git(web.path, 'worktree', 'list')).not.toContain(extraDir)
  })

  it('works in the checkouts themselves without the worktree switch', async () => {
    const { body } = await createTask({ repo_ids: [web.id, api.id] })
    expect(body.data.repos).toEqual([
      { id: web.id, slug: 'acme/web', dir: web.path, worktree: false },
      { id: api.id, slug: 'acme/api', dir: api.path, worktree: false },
    ])
    await started(1)
    expect(lastCall()).toMatchObject({ cwd: web.path, additionalDirectories: [api.path, workspaceDir(body.data.id)] })
    expect((await tasks.get(body.data.id))?.worktree).toBe(false)
  })

  it('keeps one-repo and no-repo tasks as they were', async () => {
    const single = await createTask({ repo_id: api.id })
    expect(single.body.data.repos).toEqual([{ id: api.id, slug: 'acme/api', dir: api.path, worktree: false }])
    await started(1)
    expect(lastCall()?.additionalDirectories).toEqual([workspaceDir(single.body.data.id)])
    expect(await taskReposContext(single.body.data.id)).toBeNull()

    const plain = await createTask({ cwd: scratch })
    expect(plain.body.data).toMatchObject({ repo_id: null, repos: [], cwd: scratch })
    await started(2)
    expect(lastCall()?.additionalDirectories).toEqual([workspaceDir(plain.body.data.id)])
  })

  it('removes the worktrees it made when a later repo fails', async () => {
    const broken = await scratchRepo('broken')
    await repos.update(broken.id, { slug: broken.slug, path: broken.path, base_branch: 'missing' })
    const before = fs.readdirSync(WORKTREE_ROOT)
    const count = (await tasks.list()).length
    const res = await createTask({ repo_ids: [api.id, broken.id], worktree: true })
    expect(res.status).toBe(500)
    expect(fs.readdirSync(WORKTREE_ROOT)).toEqual(before)
    expect(await tasks.list()).toHaveLength(count)
    await repos.remove(broken.id)
  })

  it('records every repo in the audit log', async () => {
    const { body } = await createTask({ repo_ids: [api.id, web.id] })
    const page = await send<AuditPage>('GET', '/audit?kind=task.created&limit=1')
    const [event] = page.body.data.events as [AuditEvent]
    expect(event).toMatchObject({
      subject_id: body.data.id,
      summary: 'Created task "Cross repo" in acme/api + acme/web',
      detail: { repo: 'acme/api', repos: ['acme/api', 'acme/web'] },
    })
  })
})

describe('repo selection validation', () => {
  const unknown = '44444444-4444-4444-8444-444444444444'

  it.each([
    [{ repo_ids: ['nope'] }, 'repo_ids.0: Invalid UUID'],
    [{ repo_ids: [api.id, api.id] }, 'repo_ids: a repo can only be picked once'],
    [{ repo_ids: [api.id], repo_id: web.id }, 'repo_id: send repo_ids or repo_id, not both'],
    [{ repo_ids: Array.from({ length: 11 }, () => crypto.randomUUID()) }, 'repo_ids: pick at most 10 repos'],
    [{ repo_ids: [api.id, unknown] }, 'Unknown repo'],
  ])('rejects a task with %j', async (selection, message) => {
    const res = await createTask(selection)
    expect(res.status).toBe(400)
    expect(res.body.error?.detail).toBe(message)
  })
})
