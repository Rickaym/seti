import fs from 'node:fs'
import path from 'node:path'
import type { Orphan, RemovalResult, Task } from '@seti/shared'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { refuseDelegates } from './ea-guard.js'
import { folderUnsavedWork } from './git-state.js'
import { forgetWorktree } from './git.js'
import {
  busyReason,
  OWNED_ROOTS,
  removalRefusal,
  removeOwnedDir,
  usedDirs,
  within,
  type OwnedRoot,
} from './owned-dirs.js'
import { bySize, cachedSize, forgetSizes, freshSize } from './size-cache.js'
import { taskLocation, type WorktreeRecord } from './store/task-location.js'

/** The roots Seti makes agents' folders in, which orphans are looked for in. */
const ORPHAN_ROOTS = ['scratch', 'worktrees', 'workspace', 'sandbox', 'archive'] as const satisfies readonly OwnedRoot[]

/** A folder that changed lately may belong to an agent still starting, so it stays this long. */
const GRACE_MS = 60 * 60 * 1000

/** A worktree name `<repo>-<id8>` or `<repo>-<id8>-<n>`, or a scratch name `<slug>-<id8>`. */
const TASK_SUFFIX = /-([0-9a-f]{8})(?:-\d+)?$/

const AUDIT_PATHS_MAX = 50

const bytesText = (bytes: number) => `${String(bytes)} bytes`

function realOrSelf(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

interface Owners {
  all: Task[]
  used: string[]
  ids: Set<string>
  shortIds: Set<string>
}

async function owners(): Promise<Owners> {
  const all = await tasks.listAll()
  const used = [...all.flatMap(usedDirs), ...(await taskLocation.allWorktreeDirs())]
  return {
    all,
    used: [...used, ...used.map(realOrSelf)],
    ids: new Set(all.map((task) => task.id)),
    shortIds: new Set(all.map((task) => task.id.slice(0, 8))),
  }
}

/** Whether an agent, live or archived, is named in the folder, uses it or works inside it. */
function owned(dir: string, who: Owners): boolean {
  const name = path.basename(dir)
  const short = TASK_SUFFIX.exec(name)?.[1]
  const real = realOrSelf(dir)
  return (
    who.ids.has(name) ||
    (short !== undefined && who.shortIds.has(short)) ||
    who.used.some((p) => within(p, dir) || within(p, real))
  )
}

/** When the folder or anything directly in it last changed. */
function lastChange(dir: string): number {
  let newest = fs.lstatSync(dir).mtimeMs
  const names = (() => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  })()
  for (const name of names) {
    newest = Math.max(newest, fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0)
  }
  return newest
}

export interface FoundOrphan extends Orphan {
  root: OwnedRoot | null
  record: WorktreeRecord | null
}

/** Why a folder holds work removing it would lose, or is in use now; null when neither. */
export type WorkCheck = (dir: string) => Promise<string | null>

/** A process working in the folder, or work git has not saved in a repository in it. */
export const workNow: WorkCheck = async (dir) => (await busyReason(dir)) ?? (await folderUnsavedWork(dir))

/** Why removing orphans leaves a folder: its path, a recent change, a process or unsaved work. */
async function keptBecause(dir: string, root: OwnedRoot, changedAgo: number, work: WorkCheck) {
  const refusal = removalRefusal(dir, root, [])
  if (refusal !== null) {
    return refusal
  }
  if (changedAgo < GRACE_MS) {
    return 'it changed in the last hour, so an agent may be starting in it'
  }
  return work(dir)
}

async function orphanFolders(who: Owners, at: number, work: WorkCheck): Promise<FoundOrphan[]> {
  const found: FoundOrphan[] = []
  for (const root of ORPHAN_ROOTS) {
    const rootDir = OWNED_ROOTS[root]
    const entries = fs.existsSync(rootDir) ? fs.readdirSync(rootDir, { withFileTypes: true }) : []
    for (const entry of entries) {
      const dir = path.join(rootDir, entry.name)
      if (!entry.isDirectory() || entry.name.startsWith('.') || owned(dir, who)) {
        continue
      }
      const changed = lastChange(dir)
      found.push({
        path: dir,
        kind: 'folder',
        where: rootDir,
        size: cachedSize(dir),
        modified_at: new Date(changed).toISOString(),
        kept: await keptBecause(dir, root, at - changed, work),
        root,
        record: null,
      })
    }
  }
  return found
}

/** Worktree records of agents that are not archived whose folders are gone. */
async function staleRecords(): Promise<FoundOrphan[]> {
  return (await taskLocation.liveWorktreeRecords())
    .filter((record) => !fs.existsSync(record.dir))
    .map((record) => ({
      path: record.dir,
      kind: 'worktree_record',
      where: `agent "${record.title}"`,
      size: null,
      modified_at: null,
      kept: null,
      root: null,
      record,
    }))
}

/**
 * Folders no agent owns in Seti's roots, and worktree records whose folder is gone. `work` says
 * why a folder must stay; a listing passes a cached check, a removal the check made now.
 */
export async function findOrphans(work: WorkCheck = workNow, at = Date.now()): Promise<FoundOrphan[]> {
  const found = [...(await orphanFolders(await owners(), at, work)), ...(await staleRecords())]
  return found.sort((a, b) => {
    const order = bySize(a.size, b.size)
    return order !== 0 ? order : a.path.localeCompare(b.path)
  })
}

export const publicOrphan = ({ root: _root, record: _record, ...orphan }: FoundOrphan): Orphan => orphan

async function removeOne(
  orphan: FoundOrphan,
  all: readonly Task[],
): Promise<{ refusal: string | null; bytes: number | null }> {
  if (orphan.record !== null) {
    await forgetWorktree(orphan.record.repo_path, orphan.record.dir)
    await taskLocation.forgetWorktree(orphan.record.task_id, orphan.record.dir)
    return { refusal: null, bytes: null }
  }
  if (orphan.root === null) {
    return { refusal: 'it lies in no root of Seti', bytes: null }
  }
  const bytes = (await freshSize(orphan.path)).bytes
  const refusal = await removeOwnedDir(orphan.path, orphan.root, all)
  forgetSizes(orphan.path)
  return { refusal, bytes }
}

async function auditRemoval(result: RemovalResult): Promise<void> {
  const lines = result.removed
    .slice(0, AUDIT_PATHS_MAX)
    .map((removed) => `${removed.path}: ${removed.bytes === null ? 'a record' : bytesText(removed.bytes)}`)
  return audit.record({
    actor: 'user',
    kind: 'system.orphans_removed',
    subject_type: 'system',
    summary: `Removed ${String(result.removed.length)} orphan(s), ${String(result.freed_bytes)} bytes`,
    detail: {
      orphans: lines,
      removed: result.removed.length,
      freed_bytes: result.freed_bytes,
      refused: result.refused.length,
    },
  })
}

/**
 * Removes the named orphans that are still orphans now and that nothing keeps, each checked again
 * just before; anything else is refused with its reason. Folders go through owned-dirs.
 */
export async function removeOrphans(paths: readonly string[]): Promise<RemovalResult> {
  refuseDelegates('remove orphan folders')
  const now = new Map((await findOrphans()).map((orphan) => [orphan.path, orphan]))
  const all = await tasks.listAll()
  const result: RemovalResult = { removed: [], refused: [], freed_bytes: 0 }
  for (const target of new Set(paths)) {
    const orphan = now.get(target)
    if (orphan === undefined) {
      result.refused.push({ path: target, reason: 'it is not an orphan now' })
      continue
    }
    if (orphan.kept !== null) {
      result.refused.push({ path: target, reason: orphan.kept })
      continue
    }
    const { refusal, bytes } = await removeOne(orphan, all).catch((e: unknown) => ({
      refusal: e instanceof Error ? e.message : String(e),
      bytes: null,
    }))
    if (refusal === null) {
      result.removed.push({ path: target, bytes })
      result.freed_bytes += bytes ?? 0
    } else {
      result.refused.push({ path: target, reason: refusal })
    }
  }
  if (result.removed.length > 0) {
    await auditRemoval(result)
  }
  return result
}
