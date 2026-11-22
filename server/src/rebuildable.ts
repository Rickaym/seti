import fs from 'node:fs'
import path from 'node:path'
import { REBUILDABLE_DIRS, REBUILDABLE_IF_IGNORED } from '@seti/shared'
import { agentGitWithin } from './git.js'
import { within, type NestedIn } from './owned-dirs.js'
import { isRepoRoot } from './sandbox-mounts.js'

const ALWAYS = new Set<string>(REBUILDABLE_DIRS)
const IF_IGNORED = new Set<string>(REBUILDABLE_IF_IGNORED)
const VIRTUALENVS = new Set(['.venv', 'venv'])
const FIND_DEPTH = 6
const FIND_DIRS_MAX = 20_000
const GIT_TIMEOUT_MS = 10_000
const GIT_BATCH = 100

/** Rebuildable by its name, rebuildable only where git ignores it, or neither. */
export type RebuildableKind = 'always' | 'ignored'

/** What a folder's name, and for a virtualenv its marker file, make it. */
export function rebuildableKind(dir: string): RebuildableKind | null {
  const name = path.basename(dir)
  if (VIRTUALENVS.has(name)) {
    return fs.existsSync(path.join(dir, 'pyvenv.cfg')) ? 'always' : null
  }
  if (ALWAYS.has(name)) {
    return 'always'
  }
  return IF_IGNORED.has(name) ? 'ignored' : null
}

export interface Candidate {
  dir: string
  kind: RebuildableKind
}

/** What a sandbox folder keeps besides its home and /tmp: sockets, ssh files and run state. */
const SANDBOX_OWN = new Set(['run', 'ssh', 'ssh-agent', 'tmp'])

function readEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** A sandbox's /tmp, which Clean empties whole when it holds anything. */
function sandboxTmp(inside: NestedIn): Candidate[] {
  const tmp = path.join(inside.base, 'tmp')
  return inside.root === 'sandbox' && readEntries(tmp).length > 0 ? [{ dir: tmp, kind: 'always' }] : []
}

/**
 * The rebuildable folders in an agent folder, a few levels down, never past a symlink, a `.git`
 * folder or another rebuildable folder. `capped` when the folder held too many to look through.
 */
export function findCandidates(inside: NestedIn): { candidates: Candidate[]; capped: boolean } {
  const candidates = sandboxTmp(inside)
  const queue = [{ dir: inside.base, depth: 0 }]
  let visited = 0
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    visited += 1
    if (visited > FIND_DIRS_MAX) {
      return { candidates, capped: true }
    }
    const sandboxTop = inside.root === 'sandbox' && next.depth === 0
    for (const entry of readEntries(next.dir)) {
      if (!entry.isDirectory() || entry.name === '.git' || (sandboxTop && SANDBOX_OWN.has(entry.name))) {
        continue
      }
      const dir = path.join(next.dir, entry.name)
      const kind = rebuildableKind(dir)
      if (kind !== null) {
        candidates.push({ dir, kind })
      } else if (next.depth + 1 < FIND_DEPTH) {
        queue.push({ dir, depth: next.depth + 1 })
      }
    }
  }
  return { candidates, capped: false }
}

/** The repository whose work tree holds `dir`, looking up to `base`; null outside one. */
function repoOf(dir: string, base: string): string | null {
  for (let current = path.dirname(dir); within(current, base); current = path.dirname(current)) {
    if (isRepoRoot(current)) {
      return current
    }
    if (current === base) {
      break
    }
  }
  return null
}

const chunks = <T>(items: readonly T[]) =>
  Array.from({ length: Math.ceil(items.length / GIT_BATCH) }, (_, i) => items.slice(i * GIT_BATCH, (i + 1) * GIT_BATCH))

/** The folders, relative to the repository, that hold at least one file git tracks. */
async function trackedIn(repo: string, rels: readonly string[]): Promise<Set<string>> {
  const tracked = new Set<string>()
  for (const chunk of chunks(rels)) {
    const listed = await agentGitWithin(GIT_TIMEOUT_MS, repo, 'ls-files', '-z', '--', ...chunk)
    for (const file of listed.split('\0').filter((name) => name !== '')) {
      const owner = chunk.find((rel) => file === rel || file.startsWith(`${rel}/`))
      if (owner !== undefined) {
        tracked.add(owner)
      }
    }
  }
  return tracked
}

const exitCode = (e: unknown) => (e instanceof Error && 'code' in e ? e.code : undefined)

/** The folders, relative to the repository, that git ignores; check-ignore exits 1 for none. */
async function ignoredIn(repo: string, rels: readonly string[]): Promise<Set<string>> {
  const ignored = new Set<string>()
  for (const chunk of chunks(rels)) {
    const listed = await agentGitWithin(GIT_TIMEOUT_MS, repo, 'check-ignore', '--', ...chunk).catch((e: unknown) => {
      if (exitCode(e) === 1) {
        return ''
      }
      throw e
    })
    for (const line of listed.split('\n').filter((name) => name !== '')) {
      ignored.add(line)
    }
  }
  return ignored
}

export interface Judged {
  targets: string[]
  kept: { dir: string; reason: string }[]
}

/** One repository's candidates: never a folder git tracks files in, build output only if ignored. */
async function judgeInRepo(repo: string, found: readonly Candidate[], judged: Judged): Promise<void> {
  const rels = found.map((candidate) => path.relative(repo, candidate.dir))
  try {
    const tracked = await trackedIn(repo, rels)
    const ignored = await ignoredIn(
      repo,
      rels.filter((_, i) => found[i]?.kind === 'ignored'),
    )
    found.forEach((candidate, i) => {
      const rel = rels[i] ?? ''
      if (tracked.has(rel)) {
        judged.kept.push({ dir: candidate.dir, reason: 'git tracks files in it' })
      } else if (candidate.kind === 'ignored' && !ignored.has(rel)) {
        judged.kept.push({ dir: candidate.dir, reason: 'git does not ignore it, so it may be source' })
      } else {
        judged.targets.push(candidate.dir)
      }
    })
  } catch {
    judged.kept.push(...found.map((candidate) => ({ dir: candidate.dir, reason: 'git could not check it' })))
  }
}

/** Which candidates Clean removes, and why it leaves the others. */
export async function judgeCandidates(base: string, candidates: readonly Candidate[]): Promise<Judged> {
  const judged: Judged = { targets: [], kept: [] }
  const byRepo = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const repo = repoOf(candidate.dir, base)
    if (repo !== null) {
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), candidate])
    } else if (candidate.kind === 'always') {
      judged.targets.push(candidate.dir)
    } else {
      judged.kept.push({ dir: candidate.dir, reason: 'it is in no git repository, so it may be source' })
    }
  }
  for (const [repo, found] of byRepo) {
    await judgeInRepo(repo, found, judged)
  }
  return judged
}
