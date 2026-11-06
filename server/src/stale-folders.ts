import fs from 'node:fs'
import path from 'node:path'
import type {
  DeleteStaleFoldersInput,
  StaleFolder,
  StaleFolderDeleteResult,
  StaleFolderReport,
  Task,
} from '@seti/shared'
import { audit } from './audit.js'
import { SCRATCH_ROOT, WORKTREE_ROOT } from './config.js'
import { tasks } from './db.js'
import { directoryBytes, removeLinkedWorktree } from './git.js'
import { busyReason, removalRefusal, usedDirs, within, type OwnedRoot } from './owned-dirs.js'
import { taskLocation } from './store/task-location.js'

const DAY_MS = 24 * 60 * 60 * 1000
const SIZE_CONCURRENCY = 4

/** A worktree name `<repo>-<id8>` or `<repo>-<id8>-<n>`, or a scratch name `<slug>-<id8>`. */
const TASK_SUFFIX = /-([0-9a-f]{8})(?:-\d+)?$/

const ROOTS = [
  { root: 'scratch', dir: SCRATCH_ROOT },
  { root: 'worktrees', dir: WORKTREE_ROOT },
] as const satisfies readonly { root: OwnedRoot & StaleFolder['root']; dir: string }[]

function realOrSelf(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/** When the folder or anything directly in it last changed. */
function lastChange(dir: string): number {
  let newest = fs.lstatSync(dir).mtimeMs
  for (const name of fs.readdirSync(dir)) {
    const stat = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false })
    newest = Math.max(newest, stat?.mtimeMs ?? 0)
  }
  return newest
}

function checkoutOf(dir: string): StaleFolder['checkout'] {
  const stat = fs.lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })
  if (stat?.isDirectory() === true) {
    return 'repo'
  }
  return stat?.isFile() === true ? 'worktree' : null
}

interface Owners {
  all: Task[]
  used: string[]
  ids: Set<string>
}

async function owners(): Promise<Owners> {
  const all = await tasks.listAll()
  const used = [...all.flatMap(usedDirs), ...(await taskLocation.allWorktreeDirs())]
  return { all, used: [...used, ...used.map(realOrSelf)], ids: new Set(all.map((task) => task.id.slice(0, 8))) }
}

/** Whether an agent, live or archived, uses the folder, works inside it or is named in it. */
function owned(dir: string, { used, ids }: Owners): boolean {
  const real = realOrSelf(dir)
  const id = TASK_SUFFIX.exec(path.basename(dir))?.[1]
  return (id !== undefined && ids.has(id)) || used.some((p) => within(p, dir) || within(p, real))
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let start = 0; start < items.length; start += size) {
    out.push(...(await Promise.all(items.slice(start, start + size).map(fn))))
  }
  return out
}

async function scan(days: number, sized: boolean, at: number): Promise<StaleFolder[]> {
  const who = await owners()
  const cutoff = at - days * DAY_MS
  const found: Omit<StaleFolder, 'bytes'>[] = []
  for (const { root, dir: rootDir } of ROOTS) {
    const entries = fs.existsSync(rootDir) ? fs.readdirSync(rootDir, { withFileTypes: true }) : []
    for (const entry of entries) {
      const dir = path.join(rootDir, entry.name)
      if (!entry.isDirectory() || entry.name.startsWith('.') || owned(dir, who)) {
        continue
      }
      const changed = lastChange(dir)
      if (changed > cutoff) {
        continue
      }
      const busy = removalRefusal(dir, root, who.all) ?? (await busyReason(dir))
      found.push({ path: dir, root, modified_at: new Date(changed).toISOString(), checkout: checkoutOf(dir), busy })
    }
  }
  const sizes = sized ? await inBatches(found, SIZE_CONCURRENCY, async (f) => directoryBytes(f.path)) : []
  return found
    .map((folder, index) => ({ ...folder, bytes: sizes[index] ?? null }))
    .sort((a, b) => {
      const bigger = (b.bytes ?? 0) - (a.bytes ?? 0)
      return bigger === 0 ? a.path.localeCompare(b.path) : bigger
    })
}

/**
 * Lists folders in the scratch and worktree roots that no agent, live or archived, owns and that
 * nothing changed for `days` days, with their sizes. It changes nothing.
 */
export async function staleFolders(days: number, at = Date.now()): Promise<StaleFolderReport> {
  const folders = await scan(days, true, at)
  return {
    roots: { scratch: SCRATCH_ROOT, worktrees: WORKTREE_ROOT },
    days,
    folders,
    total_bytes: folders.reduce((sum, folder) => sum + (folder.bytes ?? 0), 0),
  }
}

async function removeStale(folder: StaleFolder): Promise<void> {
  if (folder.checkout === 'worktree') {
    try {
      if (await removeLinkedWorktree(folder.path)) {
        return
      }
    } catch {
      // git could not remove it; the folder goes below and git prunes its record later
    }
  }
  await fs.promises.rm(folder.path, { recursive: true, maxRetries: 2 })
}

/**
 * Deletes the named folders that are still stale now, checking each again just before; a folder
 * that is not on the list now, or is busy, is refused. Linked worktrees go through git.
 */
export async function deleteStaleFolders(
  input: Pick<DeleteStaleFoldersInput, 'paths' | 'days'>,
  at = Date.now(),
): Promise<StaleFolderDeleteResult> {
  const days = input.days ?? 0
  const stale = new Map((await scan(days, false, at)).map((folder) => [folder.path, folder]))
  const all = await tasks.listAll()
  const result: StaleFolderDeleteResult = { deleted: [], refused: [] }
  for (const target of new Set(input.paths)) {
    const folder = stale.get(target)
    const refusal =
      folder === undefined
        ? 'it is not a stale folder now'
        : (folder.busy ?? removalRefusal(target, folder.root, all) ?? (await busyReason(target)))
    if (folder === undefined || refusal !== null) {
      result.refused.push({ path: target, reason: refusal ?? 'it is not a stale folder now' })
      continue
    }
    const bytes = await directoryBytes(target)
    try {
      await removeStale(folder)
      result.deleted.push({ path: target, bytes })
    } catch (e) {
      result.refused.push({ path: target, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  if (result.deleted.length > 0) {
    const freed = result.deleted.reduce((sum, folder) => sum + (folder.bytes ?? 0), 0)
    await audit.record({
      actor: 'user',
      kind: 'system.stale_folders_deleted',
      subject_type: 'system',
      summary: `Deleted ${String(result.deleted.length)} stale folder(s), ${String(freed)} bytes`,
      detail: { folders: result.deleted.map((folder) => folder.path), freed_bytes: freed },
    })
  }
  return result
}
