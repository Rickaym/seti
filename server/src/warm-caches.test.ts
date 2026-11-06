import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_WARM_CACHE_PATTERNS, warmCacheSettingsInput, warmCacheSummary } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { globRegex, seedCaches, typecheckHint } from './warm-caches.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-warm-caches-'))
const worktreeRoot = path.join(scratch, 'worktrees')
fs.mkdirSync(worktreeRoot)

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const identity = ['-c', 'user.name=Seti Test', '-c', 'user.email=test@seti.invalid']
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', [...identity, '-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

function write(root: string, rel: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

const IGNORE = ['*.tsbuildinfo', '.eslintcache', '.next/', 'node_modules/', '.env*', 'outside-link', ''].join('\n')

let repoCount = 0

/** A checkout with an ignore file, plus a fresh worktree of it to seed. */
function scratchRepo(): { main: string; fresh: (name: string) => string } {
  repoCount += 1
  const main = path.join(scratch, `repo-${String(repoCount)}`)
  fs.mkdirSync(main)
  git(main, 'init', '--initial-branch=main')
  write(main, '.gitignore', IGNORE)
  write(main, 'tsconfig.json', '{ "compilerOptions": { "strict": true } }')
  write(main, 'tracked.tsbuildinfo', 'tracked')
  git(main, 'add', '.gitignore', 'tsconfig.json')
  git(main, 'add', '-f', 'tracked.tsbuildinfo')
  git(main, 'commit', '-m', 'chore: seed')
  const fresh = (name: string) => {
    const dir = path.join(worktreeRoot, `${path.basename(main)}-${name}`)
    git(main, 'worktree', 'add', '--detach', dir, 'HEAD')
    return dir
  }
  return { main, fresh }
}

const DEFAULTS: { enabled: boolean; patterns: string[]; max_mb: number } = {
  enabled: true,
  patterns: [...DEFAULT_WARM_CACHE_PATTERNS],
  max_mb: 64,
}

const seed = async (main: string, dest: string, settings: Partial<typeof DEFAULTS> = {}, budgetMs?: number) =>
  seedCaches({
    repo: { slug: 'acme/web', path: main },
    dest,
    settings: { ...DEFAULTS, ...settings },
    worktreeRoot,
    ...(budgetMs === undefined ? {} : { budgetMs }),
  })

const touch = (file: string, at: Date) => {
  fs.utimesSync(file, at, at)
}

describe('cache patterns', () => {
  it('match like ignore globs: ** spans folders, a bare name matches at any depth', () => {
    const tsbuildinfo = globRegex('**/*.tsbuildinfo')
    expect(tsbuildinfo.test('tsconfig.tsbuildinfo')).toBe(true)
    expect(tsbuildinfo.test('packages/ui/tsconfig.app.tsbuildinfo')).toBe(true)
    expect(tsbuildinfo.test('tsconfig.tsbuildinfo.bak')).toBe(false)
    const eslint = globRegex('.eslintcache')
    expect(eslint.test('.eslintcache')).toBe(true)
    expect(eslint.test('apps/web/.eslintcache')).toBe(true)
    expect(eslint.test('xeslintcache')).toBe(false)
    const next = globRegex('**/.next/cache')
    expect(next.test('.next/cache')).toBe(true)
    expect(next.test('apps/site/.next/cache')).toBe(true)
    expect(next.test('.next/server')).toBe(false)
    expect(globRegex('apps/*/dist').test('apps/web/dist')).toBe(true)
    expect(globRegex('apps/*/dist').test('apps/web/x/dist')).toBe(false)
  })

  it('refuses patterns that reach .git, .env files, parent folders or everything', () => {
    const problem = (patterns: string[]) =>
      warmCacheSettingsInput.safeParse({ enabled: true, patterns, max_mb: 10 }).error?.issues[0]?.message
    expect(problem([...DEFAULT_WARM_CACHE_PATTERNS])).toBeUndefined()
    expect(problem(['.git/objects'])).toContain('nothing under .git')
    expect(problem(['**/.env.local'])).toContain('.env files are never copied')
    expect(problem(['../other/cache'])).toContain('. and .. are not allowed')
    expect(problem(['/abs/cache'])).toContain('relative to the checkout')
    expect(problem(['**'])).toContain('name a cache')
    expect(problem(['a', 'a'])).toBe('each pattern once')
  })
})

describe('seeding a new worktree', () => {
  it('copies ignored caches only: never tracked or unignored files, .env files or links out', async () => {
    const { main, fresh } = scratchRepo()
    write(main, 'tsconfig.tsbuildinfo', 'warm')
    write(main, 'packages/ui/tsconfig.tsbuildinfo', 'warm ui')
    write(main, 'notignored.tsbuildinfo.d/keep', 'no')
    write(main, '.next/cache/webpack/pack', 'pack')
    write(main, '.next/server/page.js', 'build output')
    write(main, 'node_modules/.cache/babel/x', 'babel')
    write(main, 'node_modules/left-pad/.cache/x', 'not searched')
    write(main, '.env.local', 'SECRET=1')
    write(main, 'node_modules/.cache/.env', 'SECRET=2')
    fs.symlinkSync('/etc', path.join(main, 'node_modules', '.cache', 'etc-link'))
    fs.symlinkSync(os.tmpdir(), path.join(main, 'outside-link'))
    write(main, 'untracked.tsbuildinfo2', 'no')
    const dest = fresh('a')

    const result = await seed(main, dest, { patterns: [...DEFAULT_WARM_CACHE_PATTERNS, 'outside-link', '*.local'] })

    expect(result).toMatchObject({ outcome: 'seeded', source: 'main', source_dir: main, paths: 4 })
    expect(fs.readFileSync(path.join(dest, 'tsconfig.tsbuildinfo'), 'utf8')).toBe('warm')
    expect(fs.readFileSync(path.join(dest, 'packages/ui/tsconfig.tsbuildinfo'), 'utf8')).toBe('warm ui')
    expect(fs.readFileSync(path.join(dest, '.next/cache/webpack/pack'), 'utf8')).toBe('pack')
    expect(fs.existsSync(path.join(dest, '.next/server'))).toBe(false)
    expect(fs.readFileSync(path.join(dest, 'node_modules/.cache/babel/x'), 'utf8')).toBe('babel')
    expect(fs.existsSync(path.join(dest, 'node_modules/left-pad'))).toBe(false)
    expect(fs.readFileSync(path.join(dest, 'tracked.tsbuildinfo'), 'utf8')).toBe('tracked')
    expect(fs.existsSync(path.join(dest, '.env.local'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'node_modules/.cache/.env'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'node_modules/.cache/etc-link'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'outside-link'))).toBe(false)
    expect(result.skipped).toBe(1)
    expect(git(dest, 'status', '--porcelain')).toBe('')
    expect(warmCacheSummary(result)).toMatch(/^4 paths, \d+ KB from main checkout$/)
  })

  it('takes a newer cache from another Seti worktree of the repo, else the main checkout', async () => {
    const { main, fresh } = scratchRepo()
    write(main, 'tsconfig.tsbuildinfo', 'main')
    const sibling = fresh('sibling')
    write(sibling, 'tsconfig.tsbuildinfo', 'sibling')
    const old = new Date(Date.now() - 3_600_000)
    touch(path.join(main, 'tsconfig.tsbuildinfo'), old)

    const first = fresh('b')
    const fromSibling = await seed(main, first)
    expect(fromSibling).toMatchObject({ outcome: 'seeded', source: 'worktree', source_dir: sibling, paths: 1 })
    expect(fs.readFileSync(path.join(first, 'tsconfig.tsbuildinfo'), 'utf8')).toBe('sibling')
    fs.rmSync(path.join(first, 'tsconfig.tsbuildinfo'))

    touch(path.join(sibling, 'tsconfig.tsbuildinfo'), new Date(old.getTime() - 60_000))
    const dest = fresh('c')
    const fromMain = await seed(main, dest)
    expect(fromMain).toMatchObject({ source: 'main', source_dir: main })
    expect(fs.readFileSync(path.join(dest, 'tsconfig.tsbuildinfo'), 'utf8')).toBe('main')
  })

  it('leaves out caches beyond the size cap and never overwrites what the worktree has', async () => {
    const { main, fresh } = scratchRepo()
    write(main, 'tsconfig.tsbuildinfo', 'small')
    write(main, '.next/cache/blob', 'b'.repeat(2 * 1024 * 1024))
    const dest = fresh('d')
    write(dest, 'pkg/tsconfig.tsbuildinfo', 'mine')
    write(main, 'pkg/tsconfig.tsbuildinfo', 'theirs')

    const result = await seed(main, dest, { max_mb: 1 })

    expect(result).toMatchObject({ outcome: 'seeded', paths: 1, bytes: 5, skipped: 2 })
    expect(fs.existsSync(path.join(dest, '.next'))).toBe(false)
    expect(fs.readFileSync(path.join(dest, 'pkg/tsconfig.tsbuildinfo'), 'utf8')).toBe('mine')
  })

  it('stops at the time budget and reports it instead of failing', async () => {
    const { main, fresh } = scratchRepo()
    write(main, 'tsconfig.tsbuildinfo', 'warm')
    const result = await seed(main, fresh('e'), {}, 0)
    expect(result).toMatchObject({ outcome: 'timeout', paths: 0 })
    expect(warmCacheSummary(result)).toContain('stopped at the time limit')
  })

  it('does nothing when off, reports an empty source, and falls back on errors without throwing', async () => {
    const { main, fresh } = scratchRepo()
    const dest = fresh('f')
    expect(await seed(main, dest, { enabled: false })).toMatchObject({ outcome: 'off', paths: 0 })
    expect(await seed(main, dest)).toMatchObject({ outcome: 'empty', source: 'main' })
    const missing = await seed(path.join(scratch, 'no-such-repo'), dest)
    expect(missing.outcome).toBe('failed')
    expect(missing.reason).not.toBeNull()
  })

  it('skips caches inside nested checkouts', async () => {
    const { main, fresh } = scratchRepo()
    const nested = path.join(main, 'node_modules', '.cache', 'vendored')
    fs.mkdirSync(nested, { recursive: true })
    git(nested, 'init', '-q')
    write(nested, 'tsconfig.tsbuildinfo', 'nested')
    const result = await seed(main, fresh('g'), { patterns: ['**/*.tsbuildinfo'] })
    expect(result).toMatchObject({ outcome: 'empty' })
  })
})

describe('typecheck hint', () => {
  it('says a TypeScript repo without incremental builds cannot be warmed, until it has a tsbuildinfo', async () => {
    const { main } = scratchRepo()
    expect(await typecheckHint(main)).toContain('cannot be warmed')
    write(main, 'tsconfig.tsbuildinfo', '{}')
    expect(await typecheckHint(main)).toBeNull()
  })

  it('stays quiet for incremental configs and repos without a tsconfig', async () => {
    const { main } = scratchRepo()
    write(main, 'packages/app/tsconfig.json', '{ "compilerOptions": { "incremental": true } }')
    git(main, 'add', 'packages/app/tsconfig.json')
    expect(await typecheckHint(main)).toBeNull()
    git(main, 'rm', '-q', '--cached', 'tsconfig.json', 'packages/app/tsconfig.json')
    expect(await typecheckHint(main)).toBeNull()
  })
})
