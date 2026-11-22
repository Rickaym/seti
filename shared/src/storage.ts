import { z } from 'zod'
import { fileListQuery } from './files.js'

/** Folders a reinstall, a build or the tool that made them makes again; rebuildable by name. */
export const REBUILDABLE_DIRS = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.gradle',
  '.cache',
  '.pnpm-store',
  '.npm',
] as const

/** Build outputs that can also be source, so they are rebuildable only where git ignores them. */
export const REBUILDABLE_IF_IGNORED = ['dist', 'build', 'target', 'coverage'] as const

/** The Files view's root id that shows every root as one tree, never the id of a real root. */
export const FILES_TREE_ROOT = 'tree'

/** A folder's size from a walk; `capped` when the walk stopped at its time or entry limit. */
export interface FolderSize {
  bytes: number
  files: number
  /** The walk stopped early, so bytes and files are a floor: show them as "about". */
  capped: boolean
}

/** A repository's state at a glance, read without contacting its remotes. */
export interface GitBadge {
  /** Null on a detached HEAD. */
  branch: string | null
  /** Changed, staged and untracked files. */
  dirty: number
  /** Commits ahead of and behind the upstream; null without one. */
  ahead: number | null
  behind: number | null
}

/** One entry of a folder in the tree. */
export interface TreeEntry {
  name: string
  /** Relative to the root, with forward slashes. */
  path: string
  type: 'file' | 'dir'
  mtime: string
  /** A file's own size; a folder's from the last walk, null until one finished. */
  size: FolderSize | null
  git: GitBadge | null
  /** Dependencies, build output or caches a reinstall or build makes again. */
  rebuildable: boolean
}

export interface TreeListing {
  root: string
  path: string
  /** The listed folder's own size, null until a walk finished. */
  size: FolderSize | null
  entries: TreeEntry[]
  /** More entries than the listing returns; the first by name were kept. */
  truncated: boolean
  /** Some folder sizes are still being measured; ask again shortly. */
  measuring: boolean
}

/** One folder of the tree by root and path, with dot files and Seti's own files opted in or not. */
export const treeQuery = fileListQuery.omit({ sort: true })

export const AGENT_STORAGE_STATES = ['running', 'idle', 'archived'] as const
export type AgentStorageState = (typeof AGENT_STORAGE_STATES)[number]

/** Where a folder of an agent comes from: one Seti made for it, or a checkout the agent was given. */
export const STORAGE_FOLDER_KINDS = ['scratch', 'worktree', 'workspace', 'sandbox', 'checkout'] as const
export type StorageFolderKind = (typeof STORAGE_FOLDER_KINDS)[number]

export interface StorageFolder {
  kind: StorageFolderKind
  path: string
  size: FolderSize | null
  /** Seti made it for this agent, so Clean may work in it. */
  owned: boolean
}

export interface AgentStorage {
  task_id: string
  title: string
  state: AgentStorageState
  last_activity: string
  /** Null until every folder was measured once. */
  size: FolderSize | null
  /** What Clean would free; null until measured. */
  rebuildable_bytes: number | null
  folders: StorageFolder[]
}

export const ORPHAN_KINDS = ['folder', 'worktree_record'] as const
export type OrphanKind = (typeof ORPHAN_KINDS)[number]

/** A folder in one of Seti's roots no agent owns, or a worktree record whose folder is gone. */
export interface Orphan {
  path: string
  kind: OrphanKind
  /** The root it lies in, such as the work root; for a record, the agent it names. */
  where: string
  size: FolderSize | null
  modified_at: string | null
  /** Why removing orphans leaves it, such as unpushed commits; null when it goes. */
  kept: string | null
}

export const SCHEDULE_IDLE_DAYS = [7, 14, 30] as const
export type ScheduleIdleDays = (typeof SCHEDULE_IDLE_DAYS)[number]

/** The automatic clean: off by default; when on, cleans agents idle longer than `idle_days`. */
export interface StorageSchedule {
  enabled: boolean
  idle_days: ScheduleIdleDays
  last_run_at: string | null
  last_freed_bytes: number | null
}

export const STORAGE_SCHEDULE_DEFAULTS: StorageSchedule = {
  enabled: false,
  idle_days: 14,
  last_run_at: null,
  last_freed_bytes: null,
}

export const storageScheduleInput = z
  .object({
    enabled: z.boolean().optional(),
    idle_days: z
      .number()
      .int()
      .refine((days): days is ScheduleIdleDays => (SCHEDULE_IDLE_DAYS as readonly number[]).includes(days), {
        message: 'pick 7, 14 or 30 days',
      })
      .optional(),
  })
  .refine((input) => input.enabled !== undefined || input.idle_days !== undefined, 'give enabled, idle_days or both')
export type StorageScheduleInput = z.input<typeof storageScheduleInput>
export type StorageScheduleChange = z.output<typeof storageScheduleInput>

export interface DiskSpace {
  path: string
  total_bytes: number
  free_bytes: number
}

export interface StorageOverview {
  disk: DiskSpace | null
  /** Every agent's folders and the orphans, as far as measured. */
  total_bytes: number
  rebuildable_bytes: number
  agents: AgentStorage[]
  orphans: Orphan[]
  /** Some sizes are still being measured; ask again shortly. */
  measuring: boolean
  schedule: StorageSchedule
}

/** One rebuildable folder Clean removes, inside one of the agent's own folders. */
export interface CleanTarget {
  /** Absolute; what a confirmed Clean names. */
  dir: string
  /** The agent folder it lies in, and its path there. */
  base: string
  path: string
  bytes: number | null
}

/** What Clean would remove now and why it would leave the rest. */
export interface CleanPlan {
  task_id: string
  title: string
  targets: CleanTarget[]
  bytes: number
  /** Why Clean cannot run now, such as the agent running; null when it can. */
  refused: string | null
  kept: { dir: string; reason: string }[]
  /** Some sizes are still being measured; ask again shortly. */
  measuring: boolean
}

const STORAGE_PATHS_MAX = 500

const pathList = z.array(z.string().min(1).max(4096)).min(1, 'pick at least one folder').max(STORAGE_PATHS_MAX)

/** Removal cannot be undone, so the caller names what it saw and says it means it. */
export const cleanInput = z.object({ dirs: pathList, confirm: z.literal(true, 'confirm the clean') })
export type CleanInput = z.input<typeof cleanInput>

export const removeOrphansInput = z.object({ paths: pathList, confirm: z.literal(true, 'confirm the removal') })
export type RemoveOrphansInput = z.input<typeof removeOrphansInput>

export interface RemovalResult {
  removed: { path: string; bytes: number | null }[]
  refused: { path: string; reason: string }[]
  freed_bytes: number
}
