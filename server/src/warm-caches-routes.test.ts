import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { Repo, Task, WarmCacheStatus } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { repos } from './db.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const sdk = vi.hoisted(() => ({ sessions: 0 }))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: () => {
    sdk.sessions += 1
    const session = (async function* () {
      await Promise.resolve()
      yield* []
    })()
    return Object.assign(session, { close: () => undefined })
  },
}))

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-warm-routes-'))

/** Sessions start just after a task is created; waiting keeps them inside the test's database. */
async function started(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(sdk.sessions).toBe(count)
  })
}

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const identity = ['-c', 'user.name=Seti Test', '-c', 'user.email=test@seti.invalid']
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', [...identity, '-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

/** A registered TypeScript checkout with an origin, ignoring tsbuildinfo files. */
async function scratchRepo(name: string): Promise<Repo> {
  const origin = path.join(scratch, `${name}.git`)
  const checkout = path.join(scratch, name)
  fs.mkdirSync(checkout)
  git(scratch, 'init', '--bare', '--initial-branch=main', origin)
  git(checkout, 'init', '--initial-branch=main')
  fs.writeFileSync(path.join(checkout, '.gitignore'), '*.tsbuildinfo\n')
  fs.writeFileSync(path.join(checkout, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'chore: seed')
  git(checkout, 'remote', 'add', 'origin', origin)
  git(checkout, 'push', '-q', 'origin', 'main')
  const repo: Repo = {
    id: crypto.randomUUID(),
    slug: `acme/${name}`,
    path: checkout,
    base_branch: 'main',
    created_at: 'x',
  }
  await repos.insert(repo)
  return repo
}

const app = createApp()

interface Reply<T> {
  status: number
  body: { data: T }
}

async function send<T>(
  method: string,
  url: string,
  body?: unknown,
  auth: Record<string, string> = USER_AUTH,
): Promise<Reply<T>> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Reply<T>['body'] }
}

const settings = (patterns: string[], extra: Record<string, unknown> = {}) => ({
  enabled: true,
  patterns,
  max_mb: 100,
  ...extra,
})

describe('warm cache settings', () => {
  it('starts from the defaults and hints that a non-incremental typecheck cannot be warmed', async () => {
    const repo = await scratchRepo('hinted')
    const { status, body } = await send<WarmCacheStatus>('GET', `/repos/${repo.id}/warm-caches`)
    expect(status).toBe(200)
    expect(body.data.settings).toEqual({ ...body.data.defaults, updated_at: null })
    expect(body.data.settings.patterns).toContain('**/*.tsbuildinfo')
    expect(body.data.hint).toContain('cannot be warmed')
    fs.writeFileSync(path.join(repo.path, 'tsconfig.json'), '{ "compilerOptions": { "incremental": true } }\n')
    git(repo.path, 'commit', '-qam', 'chore: incremental')
    expect((await send<WarmCacheStatus>('GET', `/repos/${repo.id}/warm-caches`)).body.data.hint).toBeNull()
  })

  it('saves checked settings and audits what changed, for the user and the EA', async () => {
    const repo = await scratchRepo('saved')
    const saved = await send<WarmCacheStatus>('PUT', `/repos/${repo.id}/warm-caches`, settings(['**/.vite']))
    expect(saved.status).toBe(200)
    expect(saved.body.data.settings).toMatchObject({ enabled: true, patterns: ['**/.vite'], max_mb: 100 })
    expect(await auditEvents.latest('repo.warm_caches_changed')).toMatchObject({
      actor: 'user',
      subject_id: repo.id,
      summary: expect.stringContaining('added **/.vite; removed **/*.tsbuildinfo') as string,
      detail: { slug: 'acme/saved', patterns: ['**/.vite'], max_mb: 100, patterns_added: ['**/.vite'] },
    })

    const off = await send('PUT', `/repos/${repo.id}/warm-caches`, settings(['**/.vite'], { enabled: false }), EA_AUTH)
    expect(off.status).toBe(200)
    expect(await auditEvents.latest('repo.warm_caches_changed')).toMatchObject({
      summary: 'Warm caches for acme/saved: turned off',
      detail: { enabled: false, was_enabled: true, via: 'ea' },
    })
  })

  it('refuses unsafe patterns, bad caps and unknown repos', async () => {
    const repo = await scratchRepo('refused')
    const env = await send('PUT', `/repos/${repo.id}/warm-caches`, settings(['.env.local']))
    expect(env.status).toBe(400)
    expect(JSON.stringify(env.body)).toContain('.env files are never copied')
    expect((await send('PUT', `/repos/${repo.id}/warm-caches`, settings(['.git/x']))).status).toBe(400)
    expect((await send('PUT', `/repos/${repo.id}/warm-caches`, settings([], { max_mb: 0 }))).status).toBe(400)
    expect((await send('GET', `/repos/${crypto.randomUUID()}/warm-caches`)).status).toBe(404)
  })
})

describe('seeding new agent worktrees', () => {
  it('copies the main checkout caches before the first turn and records them on the task', async () => {
    const repo = await scratchRepo('seeded')
    fs.writeFileSync(path.join(repo.path, 'tsconfig.tsbuildinfo'), '{"warm":true}')
    const { status, body } = await send<Task>('POST', '/tasks', {
      title: 'Warm start',
      prompt: 'Typecheck',
      repo_ids: [repo.id],
      worktree: true,
    })
    expect(status).toBe(200)
    await started(1)
    const task = body.data
    expect(fs.readFileSync(path.join(task.cwd, 'tsconfig.tsbuildinfo'), 'utf8')).toBe('{"warm":true}')
    expect(task.warm_caches).toEqual([
      expect.objectContaining({ repo: 'acme/seeded', outcome: 'seeded', source: 'main', paths: 1, bytes: 13 }),
    ])
    expect(await auditEvents.latest('task.caches_seeded')).toMatchObject({
      subject_id: task.id,
      summary: expect.stringMatching(/^Warm caches: 1 path, 1 KB from main checkout for task "Warm start"$/) as string,
      detail: { paths: 1, bytes: 13, sources: [repo.path] },
    })
  })

  it('records nothing to audit when seeding is off, and still starts the agent when seeding fails', async () => {
    const off = await scratchRepo('off')
    await send('PUT', `/repos/${off.id}/warm-caches`, settings(['**/*.tsbuildinfo'], { enabled: false }))
    const before = await auditEvents.latest('task.caches_seeded')
    const quiet = await send<Task>('POST', '/tasks', {
      title: 'Cold',
      prompt: 'Go',
      repo_ids: [off.id],
      worktree: true,
    })
    expect(quiet.body.data.warm_caches).toEqual([expect.objectContaining({ outcome: 'off' })])
    await started(2)
    expect((await auditEvents.latest('task.caches_seeded'))?.id).toBe(before?.id)

    const broken = await scratchRepo('broken')
    const unreadable = path.join(broken.path, 'tsconfig.tsbuildinfo')
    fs.writeFileSync(unreadable, 'secret-ish')
    fs.chmodSync(unreadable, 0o000)
    const begun = await send<Task>('POST', '/tasks', {
      title: 'Still starts',
      prompt: 'Go',
      repo_ids: [broken.id],
      worktree: true,
    })
    fs.chmodSync(unreadable, 0o600)
    expect(begun.status).toBe(200)
    await started(3)
    expect(begun.body.data.warm_caches).toEqual([expect.objectContaining({ outcome: 'failed', paths: 0 })])
    expect(fs.existsSync(path.join(begun.body.data.cwd, 'tsconfig.tsbuildinfo'))).toBe(false)
  })

  it('seeds a worktree added to a running agent', async () => {
    const first = await scratchRepo('first')
    const second = await scratchRepo('second')
    fs.writeFileSync(path.join(second.path, 'tsconfig.tsbuildinfo'), 'second')
    const task = (await send<Task>('POST', '/tasks', { title: 'Two', prompt: 'Go', repo_ids: [first.id] })).body.data
    expect(task.warm_caches).toEqual([])
    await started(4)
    const added = await send<Task>('POST', `/tasks/${task.id}/repos`, { repo_id: second.id, worktree: true })
    expect(added.status).toBe(200)
    const dir = added.body.data.repos.find((entry) => entry.id === second.id)?.dir ?? ''
    expect(fs.readFileSync(path.join(dir, 'tsconfig.tsbuildinfo'), 'utf8')).toBe('second')
    expect(added.body.data.warm_caches).toEqual([expect.objectContaining({ repo: 'acme/second', outcome: 'seeded' })])
  })
})
