import { execFile } from 'node:child_process'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import {
  warmCacheNote,
  type AuditActor,
  type Repo,
  type Task,
  type WarmCacheSeed,
  type WarmCacheSettings,
} from '@seti/shared'
import { audit } from './audit.js'
import { WORKTREE_ROOT } from './config.js'
import { listWorktrees } from './git.js'
import { recordWarmCacheSeed, warmCacheSettings } from './store/warm-caches.js'

const exec = promisify(execFile)

/** Seeding finishes or gives up within this, before the agent's first turn starts. */
const SEED_BUDGET_MS = 20_000
/** Other worktrees of the repo looked at as a source, the most recently used first. */
const SIBLINGS_SCANNED = 3
/** How deep a scan looks inside a gitignored directory for a cache. */
const WALK_DEPTH = 4
/** A directory this large is not searched for caches, such as a package store. */
const DIR_ENTRY_LIMIT = 5000
const NO_DESCENT = new Set(['.venv', 'venv', 'site-packages', '.pnpm'])
const MB = 1024 * 1024

class Timeout extends Error {}

const escapeRegex = (text: string) => text.replace(/[\\^$.|?+()[\]{}]/g, '\\$&')

/** A cache glob as a regex: `**` spans directories, `*` one name; without a slash, any depth. */
export function globRegex(pattern: string): RegExp {
  const parts = (pattern.includes('/') ? pattern : `**/${pattern}`).split('/')
  const body = parts
    .map((part, i) => {
      const last = i === parts.length - 1
      if (part === '**') {
        return last ? '.*' : '(?:[^/]+/)*'
      }
      return part.split('*').map(escapeRegex).join('[^/]*') + (last ? '' : '/')
    })
    .join('')
  return new RegExp(`^${body}$`)
}

/** Never copied whatever the patterns say. */
const isBlocked = (rel: string) => rel.split('/').some((part) => part === '.git' || part.startsWith('.env'))

interface CachePath {
  rel: string
  /** Index of the pattern it matched; earlier patterns are copied first. */
  pattern: number
  mtimeMs: number
}

interface Scan {
  root: string
  matchers: RegExp[]
  deadline: number
  found: CachePath[]
  /** Matches left out, such as symlinks leading outside the checkout. */
  refused: string[]
}

function checkDeadline(deadline: number): void {
  if (performance.now() > deadline) {
    throw new Timeout('time limit')
  }
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const child = exec('git', ['-C', cwd, ...args], { maxBuffer: 64 * MB })
  if (input !== undefined) {
    child.child.stdin?.end(input)
  }
  return (await child).stdout
}

const splitZ = (out: string) => out.split('\0').filter((entry) => entry !== '')

/** Gitignored, untracked files and directories of a checkout; a directory stands for all inside. */
async function ignoredEntries(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  return splitZ(out).map((entry) => entry.replace(/\/$/, ''))
}

const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep)

/** True for a link with a relative target that resolves within the checkout. */
async function safeLink(root: string, abs: string): Promise<boolean> {
  if (path.isAbsolute(await fs.readlink(abs))) {
    return false
  }
  return inside(await fs.realpath(root), await fs.realpath(abs))
}

async function newestChild(abs: string, own: number): Promise<number> {
  const names: string[] = await fs.readdir(abs).catch(() => [])
  let newest = own
  for (const name of names.slice(0, DIR_ENTRY_LIMIT)) {
    const stat = await fs.lstat(path.join(abs, name)).catch(() => null)
    newest = Math.max(newest, stat?.mtimeMs ?? 0)
  }
  return newest
}

async function recordMatch(scan: Scan, rel: string, stat: Stats, pattern: number): Promise<void> {
  const abs = path.join(scan.root, rel)
  if (stat.isSymbolicLink()) {
    if (await safeLink(scan.root, abs).catch(() => false)) {
      scan.found.push({ rel, pattern, mtimeMs: stat.mtimeMs })
    } else {
      scan.refused.push(rel)
    }
    return
  }
  const mtimeMs = stat.isDirectory() ? await newestChild(abs, stat.mtimeMs) : stat.mtimeMs
  scan.found.push({ rel, pattern, mtimeMs })
}

/** Children of a directory worth searching; none in a nested checkout or a huge directory. */
async function searchable(abs: string): Promise<string[]> {
  const name = path.basename(abs)
  const names: string[] = await fs.readdir(abs).catch(() => [])
  if (names.includes('.git') || names.length > DIR_ENTRY_LIMIT) {
    return []
  }
  return name === 'node_modules' ? names.filter((child) => child.startsWith('.')) : names
}

async function visit(scan: Scan, rel: string, depth: number): Promise<void> {
  checkDeadline(scan.deadline)
  const stat = isBlocked(rel) ? null : await fs.lstat(path.join(scan.root, rel)).catch(() => null)
  if (stat === null) {
    return
  }
  const pattern = scan.matchers.findIndex((matcher) => matcher.test(rel))
  if (pattern >= 0) {
    await recordMatch(scan, rel, stat, pattern)
    return
  }
  if (!stat.isDirectory() || depth >= WALK_DEPTH || NO_DESCENT.has(path.basename(rel))) {
    return
  }
  for (const child of await searchable(path.join(scan.root, rel))) {
    await visit(scan, `${rel}/${child}`, depth + 1)
  }
}

/** Drops paths git tracks or does not ignore, repeats, and paths inside another found path. */
async function confirmIgnored(root: string, found: CachePath[]): Promise<CachePath[]> {
  if (found.length === 0) {
    return []
  }
  const rels = found.map((entry) => entry.rel)
  const listed = await git(root, ['check-ignore', '-z', '--stdin'], `${rels.join('\0')}\0`).catch(() => '')
  const ignored = new Set(splitZ(listed))
  const tracked = splitZ(await git(root, ['ls-files', '-z', '--', ...rels.map((rel) => `:(literal)${rel}`)]))
  const hasTracked = (rel: string) => tracked.some((file) => file === rel || file.startsWith(`${rel}/`))
  const sorted = found.filter((entry) => ignored.has(entry.rel) && !hasTracked(entry.rel))
  sorted.sort((a, b) => a.rel.localeCompare(b.rel))
  const covered = (rel: string, other: string) => rel === other || rel.startsWith(`${other}/`)
  return sorted.filter((entry, i) => !sorted.slice(0, i).some((other) => covered(entry.rel, other.rel)))
}

/** The gitignored caches of a checkout that match the patterns, in pattern order. */
async function findCaches(root: string, patterns: readonly string[], deadline: number) {
  const scan: Scan = { root, matchers: patterns.map(globRegex), deadline, found: [], refused: [] }
  for (const entry of await ignoredEntries(root)) {
    await visit(scan, entry, 0)
  }
  const found = await confirmIgnored(root, scan.found)
  found.sort((a, b) => (a.pattern === b.pattern ? a.rel.localeCompare(b.rel) : a.pattern - b.pattern))
  return { found, refused: scan.refused }
}

const realpathOr = async (dir: string) => fs.realpath(dir).catch(() => dir)

const newest = (paths: readonly CachePath[]) => Math.max(0, ...paths.map((entry) => entry.mtimeMs))

/** When a worktree last had git activity, from the mtime of its index. */
async function lastUsed(dir: string): Promise<number> {
  try {
    const link = await fs.readFile(path.join(dir, '.git'), 'utf8')
    const gitDir = /^gitdir: (.+)$/m.exec(link)?.[1]
    return gitDir === undefined ? 0 : (await fs.stat(path.join(gitDir.trim(), 'index'))).mtimeMs
  } catch {
    return 0
  }
}

interface CacheSource {
  dir: string
  kind: 'main' | 'worktree'
  found: CachePath[]
  refused: string[]
}

interface SourceQuery {
  repoPath: string
  /** The new worktree, never its own source. */
  dest: string
  patterns: readonly string[]
  deadline: number
  worktreeRoot?: string | undefined
}

/** The repo's checkout, or a recently used Seti worktree of it whose caches have a newer mtime. */
async function chooseSource(query: SourceQuery): Promise<CacheSource> {
  const { repoPath, dest, patterns, deadline } = query
  const main: CacheSource = { dir: repoPath, kind: 'main', ...(await findCaches(repoPath, patterns, deadline)) }
  const skip = new Set([dest, repoPath, ...(await Promise.all([dest, repoPath].map(realpathOr)))])
  const root = query.worktreeRoot ?? WORKTREE_ROOT
  const siblings = (await listWorktrees(repoPath)).filter((dir) => !skip.has(dir) && inside(root, dir))
  const used = await Promise.all(siblings.map(async (dir) => ({ dir, at: await lastUsed(dir) })))
  used.sort((a, b) => b.at - a.at)
  let best = main
  for (const { dir } of used.slice(0, SIBLINGS_SCANNED)) {
    const found = await findCaches(dir, patterns, deadline).catch((e: unknown) => {
      if (e instanceof Timeout) {
        throw e
      }
      return null
    })
    if (found !== null && newest(found.found) > newest(best.found)) {
      best = { dir, kind: 'worktree', ...found }
    }
  }
  return best
}

interface Measured {
  bytes: number
  /** Links out of the checkout, .env files and .git folders inside a cache; removed from the copy. */
  excluded: string[]
}

async function measure(root: string, rel: string, limit: number, deadline: number): Promise<Measured> {
  const out: Measured = { bytes: 0, excluded: [] }
  const walk = async (sub: string): Promise<void> => {
    checkDeadline(deadline)
    const abs = path.join(root, sub)
    const stat = await fs.lstat(abs)
    const unsafe = stat.isSymbolicLink() && !(await safeLink(root, abs).catch(() => false))
    if (isBlocked(sub) || unsafe) {
      out.excluded.push(sub)
      return
    }
    out.bytes += stat.isDirectory() ? 0 : stat.size
    if (!stat.isDirectory() || out.bytes > limit) {
      return
    }
    for (const name of await fs.readdir(abs)) {
      await walk(`${sub}/${name}`)
      if (out.bytes > limit) {
        return
      }
    }
  }
  await walk(rel)
  return out
}

/** Copy-on-write where the filesystem can, a plain copy elsewhere; killed at the deadline. */
async function copy(src: string, dst: string, deadline: number): Promise<void> {
  const remaining = Math.max(1, Math.floor(deadline - performance.now()))
  try {
    await exec('cp', ['-a', '--reflink=auto', '--', src, dst], { signal: AbortSignal.timeout(remaining) })
  } catch (e) {
    await fs.rm(dst, { recursive: true, force: true })
    throw performance.now() > deadline ? new Timeout('time limit') : e
  }
}

export interface SeedRequest {
  repo: Pick<Repo, 'slug' | 'path'>
  dest: string
  settings: Pick<WarmCacheSettings, 'enabled' | 'patterns' | 'max_mb'>
  budgetMs?: number
  worktreeRoot?: string
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const emptySeed = (repo: string): WarmCacheSeed => ({
  repo,
  outcome: 'empty',
  source: null,
  source_dir: null,
  paths: 0,
  bytes: 0,
  ms: 0,
  skipped: 0,
  reason: null,
})

/** The closest directory on the way to `dir` that exists, resolved through links. */
async function existingAncestor(dir: string): Promise<string> {
  const real = await fs.realpath(dir).catch(() => null)
  return real ?? existingAncestor(path.dirname(dir))
}

/** Makes a copy's parent directories, refusing a path whose links lead out of the worktree. */
async function prepareParent(destRoot: string, dst: string): Promise<boolean> {
  const parent = path.dirname(dst)
  if (!inside(destRoot, await existingAncestor(parent))) {
    return false
  }
  await fs.mkdir(parent, { recursive: true })
  return inside(destRoot, await fs.realpath(parent))
}

/** Copies the gitignored build caches of a warm checkout of the repo into a new worktree. */
export async function seedCaches(request: SeedRequest): Promise<WarmCacheSeed> {
  const started = performance.now()
  const budget = request.budgetMs ?? SEED_BUDGET_MS
  const deadline = started + budget
  const seed = emptySeed(request.repo.slug)
  const done = (patch: Partial<WarmCacheSeed>): WarmCacheSeed => ({
    ...seed,
    ...patch,
    ms: Math.round(performance.now() - started),
  })
  if (!request.settings.enabled) {
    return { ...seed, outcome: 'off' }
  }
  try {
    const { patterns } = request.settings
    const source = await chooseSource({
      repoPath: request.repo.path,
      dest: request.dest,
      patterns,
      deadline,
      worktreeRoot: request.worktreeRoot,
    })
    seed.source = source.kind
    seed.source_dir = source.dir
    seed.skipped = source.refused.length
    const destRoot = await fs.realpath(request.dest)
    const cap = request.settings.max_mb * MB
    for (const entry of source.found) {
      const dst = path.join(request.dest, entry.rel)
      const room = cap - seed.bytes
      const size = await measure(source.dir, entry.rel, room, deadline)
      const taken = (await fs.lstat(dst).catch(() => null)) !== null
      if (size.bytes > room || taken || !(await prepareParent(destRoot, dst))) {
        seed.skipped += 1
        continue
      }
      await copy(path.join(source.dir, entry.rel), dst, deadline)
      for (const excluded of size.excluded) {
        await fs.rm(path.join(request.dest, excluded), { recursive: true, force: true })
      }
      seed.paths += 1
      seed.bytes += size.bytes
    }
    return done({ outcome: seed.paths > 0 ? 'seeded' : 'empty' })
  } catch (e) {
    if (e instanceof Timeout) {
      return done({ outcome: 'timeout', reason: `stopped at the ${String(Math.round(budget / 1000))} s limit` })
    }
    return done({ outcome: 'failed', reason: errorText(e).split('\n')[0] ?? 'failed' })
  }
}

/** Seeds a worktree Seti just made with the repo's saved settings; never throws. */
async function seedWorktree(repo: Repo, dest: string): Promise<WarmCacheSeed> {
  try {
    return await seedCaches({ repo, dest, settings: await warmCacheSettings.get(repo.id) })
  } catch (e) {
    return { ...emptySeed(repo.slug), outcome: 'failed', reason: errorText(e) }
  }
}

export interface SeedTarget {
  repo: Repo
  dir: string
}

export async function seedWorktrees(targets: readonly SeedTarget[]): Promise<WarmCacheSeed[]> {
  return Promise.all(targets.map(async (target) => seedWorktree(target.repo, target.dir)))
}

const total = (seeds: readonly WarmCacheSeed[], key: 'paths' | 'bytes' | 'skipped') =>
  seeds.reduce((sum, seed) => sum + seed[key], 0)

/** Keeps each seed with its worktree and audits it, unless seeding was off or found nothing. */
export async function recordSeeds(
  task: Pick<Task, 'id' | 'title'>,
  targets: readonly SeedTarget[],
  seeds: readonly WarmCacheSeed[],
  actor: AuditActor,
): Promise<void> {
  for (const [i, target] of targets.entries()) {
    const seed = seeds[i]
    if (seed !== undefined) {
      await recordWarmCacheSeed(task.id, target.dir, seed)
    }
  }
  const note = warmCacheNote(seeds)
  if (note === null) {
    return
  }
  await audit.record({
    actor,
    kind: 'task.caches_seeded',
    subject_type: 'task',
    subject_id: task.id,
    summary: `${note} for task "${task.title}"`,
    detail: {
      title: task.title,
      outcomes: seeds.map((seed) => `${seed.repo}: ${seed.outcome}`),
      sources: seeds.flatMap((seed) => (seed.source_dir === null ? [] : [seed.source_dir])),
      paths: total(seeds, 'paths'),
      bytes: total(seeds, 'bytes'),
      skipped: total(seeds, 'skipped'),
      ms: Math.max(0, ...seeds.map((seed) => seed.ms)),
    },
  })
}

const INCREMENTAL = /"(?:incremental|composite)"\s*:\s*true/
const TSCONFIGS_READ = 50

/** Why a repo's typecheck cannot be warmed, or null when it can or the repo has no tsconfig. */
export async function typecheckHint(repoPath: string): Promise<string | null> {
  try {
    const configs = splitZ(await git(repoPath, ['ls-files', '-z', '--', ':(glob)**/tsconfig*.json']))
    if (configs.length === 0) {
      return null
    }
    for (const config of configs.slice(0, TSCONFIGS_READ)) {
      const text = await fs.readFile(path.join(repoPath, config), 'utf8').catch(() => '')
      if (INCREMENTAL.test(text)) {
        return null
      }
    }
    const { found } = await findCaches(repoPath, ['**/*.tsbuildinfo'], performance.now() + SEED_BUDGET_MS)
    return found.length > 0
      ? null
      : 'Its typecheck cannot be warmed: no tsconfig sets incremental or composite, so tsc writes no .tsbuildinfo to copy.'
  } catch {
    return null
  }
}
