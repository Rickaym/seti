import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  WARM_CACHE_DEFAULTS,
  type AuditKind,
  type Repo,
  type RepoInput,
  type WarmCacheSettings,
  type WarmCacheSettingsInput,
  type WarmCacheStatus,
} from '@seti/shared'
import { audit } from './audit.js'
import { now, repos } from './db.js'
import { HttpError } from './http.js'
import { warmCacheSettings } from './store/warm-caches.js'
import { typecheckHint } from './warm-caches.js'

function assertCheckout(input: RepoInput): void {
  if (!fs.existsSync(path.join(input.path, '.git'))) {
    throw new HttpError(400, 'path must be a local git checkout')
  }
}

const VERBS = {
  'repo.added': 'Added',
  'repo.updated': 'Updated',
  'repo.removed': 'Removed',
} as const satisfies Partial<Record<AuditKind, string>>

async function auditRepo(kind: keyof typeof VERBS, repo: Repo): Promise<void> {
  await audit.record({
    actor: 'user',
    kind,
    subject_type: 'repo',
    subject_id: repo.id,
    summary: `${VERBS[kind]} repo ${repo.slug}`,
    detail: { slug: repo.slug, path: repo.path, base_branch: repo.base_branch },
  })
}

export async function requireRepo(id: string): Promise<Repo> {
  const repo = await repos.get(id)
  if (!repo) {
    throw new HttpError(404, 'Repo not found')
  }
  return repo
}

export async function warmCacheStatus(repo: Repo): Promise<WarmCacheStatus> {
  return {
    repo_id: repo.id,
    settings: await warmCacheSettings.get(repo.id),
    defaults: WARM_CACHE_DEFAULTS,
    hint: await typecheckHint(repo.path),
  }
}

const listed = (from: readonly string[], to: readonly string[]) => to.filter((item) => !from.includes(item))

async function auditWarmCaches(repo: Repo, before: WarmCacheSettings, after: WarmCacheSettings): Promise<void> {
  const added = listed(before.patterns, after.patterns)
  const removed = listed(after.patterns, before.patterns)
  const changes = [
    ...(before.enabled === after.enabled ? [] : [after.enabled ? 'turned on' : 'turned off']),
    ...(added.length === 0 ? [] : [`added ${added.join(', ')}`]),
    ...(removed.length === 0 ? [] : [`removed ${removed.join(', ')}`]),
    ...(before.max_mb === after.max_mb ? [] : [`cap ${String(after.max_mb)} MB`]),
  ]
  if (changes.length === 0) {
    return
  }
  await audit.record({
    actor: 'user',
    kind: 'repo.warm_caches_changed',
    subject_type: 'repo',
    subject_id: repo.id,
    summary: `Warm caches for ${repo.slug}: ${changes.join('; ')}`,
    detail: {
      slug: repo.slug,
      enabled: after.enabled,
      patterns: after.patterns,
      max_mb: after.max_mb,
      patterns_added: added,
      patterns_removed: removed,
      was_enabled: before.enabled,
      was_max_mb: before.max_mb,
    },
  })
}

/** Registers a local checkout as a repo agents can run in. */
export async function addRepo(input: RepoInput): Promise<Repo> {
  assertCheckout(input)
  const repo: Repo = { ...input, id: randomUUID(), created_at: now() }
  await repos.insert(repo)
  await auditRepo('repo.added', repo)
  return repo
}

/** Changes a registered repo's slug, path or base branch. */
export async function updateRepo(id: string, input: RepoInput): Promise<Repo | undefined> {
  assertCheckout(input)
  if (!(await repos.update(id, input))) {
    throw new HttpError(404, 'Repo not found')
  }
  const repo = await repos.get(id)
  if (repo) {
    await auditRepo('repo.updated', repo)
  }
  return repo
}

/** Removes a repo from Seti; its checkout on disk stays. */
export async function removeRepo(id: string): Promise<void> {
  const repo = await repos.get(id)
  await repos.remove(id)
  if (repo) {
    await auditRepo('repo.removed', repo)
  }
}

/** Saves a repo's warm cache settings, which new worktrees use. */
export async function setWarmCaches(repo: Repo, input: WarmCacheSettingsInput): Promise<WarmCacheStatus> {
  const before = await warmCacheSettings.get(repo.id)
  await warmCacheSettings.set(repo.id, input)
  await auditWarmCaches(repo, before, await warmCacheSettings.get(repo.id))
  return warmCacheStatus(repo)
}
