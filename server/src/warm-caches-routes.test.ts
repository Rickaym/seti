import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Repo, WarmCacheStatus } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { repos } from './db.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-warm-routes-'))

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
