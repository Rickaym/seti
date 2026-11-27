import fs from 'node:fs'
import path from 'node:path'
import { REBUILDABLE_DIRS, type GitBadge } from '@seti/shared'
import { isRepoRoot } from './git-dirs.js'
import { agentGitWithin } from './git.js'

const BADGE_TIMEOUT_MS = 3000
const BADGE_TTL_MS = 30_000
const BADGES_MAX = 2000
const SAFETY_TIMEOUT_MS = 10_000

const badges = new Map<string, { at: number; badge: GitBadge | null }>()

const AHEAD_BEHIND = /^# branch\.ab \+(\d+) -(\d+)$/

/** The badge `git status --porcelain=v2 --branch` gives: branch, changed files, ahead, behind. */
export function parseStatus(text: string): GitBadge {
  const badge: GitBadge = { branch: null, dirty: 0, ahead: null, behind: null }
  for (const line of text.split('\n')) {
    const counts = AHEAD_BEHIND.exec(line)
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      badge.branch = head === '(detached)' ? null : head
    } else if (counts !== null) {
      badge.ahead = Number(counts[1])
      badge.behind = Number(counts[2])
    } else if (line !== '' && !line.startsWith('#')) {
      badge.dirty += 1
    }
  }
  return badge
}

/**
 * A repository's branch, changed files and distance from its upstream, cached briefly; null for a
 * folder that is not the top of a repository, or one git cannot read in time.
 */
export async function gitBadge(dir: string, at = Date.now()): Promise<GitBadge | null> {
  if (!isRepoRoot(dir)) {
    return null
  }
  const cached = badges.get(dir)
  if (cached !== undefined && at - cached.at < BADGE_TTL_MS) {
    return cached.badge
  }
  const badge = await agentGitWithin(BADGE_TIMEOUT_MS, dir, 'status', '--porcelain=v2', '--branch').then(
    parseStatus,
    () => null,
  )
  if (badges.size >= BADGES_MAX) {
    badges.clear()
  }
  badges.set(dir, { at, badge })
  return badge
}

const REPO_DEPTH = 3
const REPO_DIRS_MAX = 5000
const SKIPPED = new Set<string>(['.git', ...REBUILDABLE_DIRS])

function readEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** The repositories at or a few levels below `dir`; null when it held too many folders to look. */
export function reposWithin(dir: string): string[] | null {
  const found: string[] = []
  const queue = [{ dir, depth: 0 }]
  let visited = 0
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    visited += 1
    if (visited > REPO_DIRS_MAX) {
      return null
    }
    if (isRepoRoot(next.dir)) {
      found.push(next.dir)
    }
    if (next.depth >= REPO_DEPTH) {
      continue
    }
    for (const entry of readEntries(next.dir)) {
      if (entry.isDirectory() && !SKIPPED.has(entry.name)) {
        queue.push({ dir: path.join(next.dir, entry.name), depth: next.depth + 1 })
      }
    }
  }
  return found
}

const hasCommits = async (repo: string) =>
  agentGitWithin(SAFETY_TIMEOUT_MS, repo, 'rev-parse', '--verify', '--quiet', 'HEAD').then(
    () => true,
    () => false,
  )

/** Why removing a repository loses work: uncommitted changes or commits on no remote; else null. */
export async function unsavedWork(repo: string): Promise<string | null> {
  try {
    if ((await agentGitWithin(SAFETY_TIMEOUT_MS, repo, 'status', '--porcelain')) !== '') {
      return `${repo} has uncommitted changes`
    }
    if (!(await hasCommits(repo))) {
      return null
    }
    const count = await agentGitWithin(
      SAFETY_TIMEOUT_MS,
      repo,
      'rev-list',
      '--count',
      'HEAD',
      '--branches',
      '--not',
      '--remotes',
    )
    return count === '0' ? null : `${repo} has ${count} commit(s) that are not pushed`
  } catch {
    return `git could not tell whether ${repo} holds unpushed work`
  }
}

/** Why a folder holds work removal would lose, in any repository a few levels down; else null. */
export async function folderUnsavedWork(dir: string): Promise<string | null> {
  const repos = reposWithin(dir)
  if (repos === null) {
    return 'it holds too many folders to check for unpushed work'
  }
  for (const repo of repos) {
    const reason = await unsavedWork(repo)
    if (reason !== null) {
      return reason
    }
  }
  return null
}
