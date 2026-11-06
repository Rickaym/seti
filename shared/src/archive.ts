import { z } from 'zod'
import type { Task } from './tasks.js'

export const AUTO_ARCHIVE_DEFAULTS = {
  enabled: true,
  days: 3,
  delete_after_days: null,
  resume_after_restart: true,
} as const
export const AUTO_ARCHIVE_DAYS_MAX = 365
export const ARCHIVE_DELETE_DAYS_MAX = 3650
export const STALE_FOLDER_DAYS_DEFAULT = 7
const STALE_FOLDERS_MAX = 500
export const ARCHIVE_BULK_MAX = 200

/** Why an archived agent takes no work; the same words for every refusal. */
export const archivedRefusal = (title: string) => `Agent "${title}" is archived; restore it first`

export const archiveTaskInput = z.object({
  /** Frees the worktree's disk when it has no uncommitted changes and its commits are pushed. */
  remove_worktree: z.boolean().default(true),
})
export type ArchiveTaskInput = z.input<typeof archiveTaskInput>

export const bulkArchiveInput = archiveTaskInput.extend({
  task_ids: z.array(z.string().min(1)).min(1, 'pick at least one agent').max(ARCHIVE_BULK_MAX),
})
export type BulkArchiveInput = z.input<typeof bulkArchiveInput>

/** Each field left unset keeps its saved value. */
export const autoArchiveInput = z.object({
  enabled: z.boolean().optional(),
  days: z.number().int().min(1, 'at least 1 day').max(AUTO_ARCHIVE_DAYS_MAX).optional(),
  /** Archived agents older than this are deleted with their files; null is off, unset keeps it. */
  delete_after_days: z.number().int().min(1, 'at least 1 day').max(ARCHIVE_DELETE_DAYS_MAX).nullable().optional(),
  resume_after_restart: z.boolean().optional(),
})
export type AutoArchiveInput = z.input<typeof autoArchiveInput>

/** Previews the rule with other days than the saved ones, as the settings form changes. */
export const autoArchivePreviewQuery = z.object({
  days: z.coerce.number().int().min(1).max(AUTO_ARCHIVE_DAYS_MAX).optional(),
})

export interface AutoArchiveSettings {
  enabled: boolean
  /** COMPLETE agents idle for at least this many days are archived. */
  days: number
  /** Archived agents are deleted this many days after archiving; null keeps them. */
  delete_after_days: number | null
  /** Agents a restart cut off get one message at startup to go on, instead of waiting on the user. */
  resume_after_restart: boolean
  /** Null while the defaults apply. */
  updated_at: string | null
}

/** A worktree an archive looked at: removed to free disk, or kept with the reason. */
export interface ArchivedWorktree {
  repo_id: string
  repo: string
  dir: string
  removed: boolean
  /** Why it was kept, such as uncommitted changes; null when removed. */
  kept_because: string | null
  /** The commit it was at and its branch, so a restore can check it out again. */
  head: string | null
  branch: string | null
  /** Disk the worktree took; null when it was kept. */
  bytes: number | null
  /** Its uncommitted changes, saved in the archive bundle when it was kept for them. */
  patch?: string | null
  /** Kept only because a process worked in it; the lifecycle sweep tries again. */
  retry?: boolean
}

/** A folder Seti made for the agent, packed into its archive bundle and removed from disk. */
export interface ArchivedFolder {
  kind: 'scratch' | 'workspace'
  dir: string
  /** Disk it took before it was packed. */
  bytes: number | null
}

/** The agent's folders packed into one tar.zst under the archive root. */
export interface TaskFilesBundle {
  /** pending: waits for a retry; bundled: packed and removed; none: nothing to pack. */
  state: 'pending' | 'bundled' | 'none'
  /** Why it waits, such as a process working in a folder; null otherwise. */
  reason: string | null
  /** The bundle's folder; null while nothing was written. */
  path: string | null
  /** Bytes the bundle takes on disk, patches included. */
  bytes: number
  folders: ArchivedFolder[]
  at: string
}

/** What an archive stores and saved; sizes in bytes. */
export interface TaskArchiveInfo {
  archived_at: string
  actor: 'user' | 'system'
  codec: string
  /** Transcript rows moved into the archive. */
  rows: number
  /** The rows' stored text before compression. */
  raw_bytes: number
  /** The compressed archive. */
  stored_bytes: number
  /** Table space the rows took, as PostgreSQL measures their columns; indexes come on top. */
  table_bytes: number
  worktrees: ArchivedWorktree[]
  /** The agent's folders on disk; null until the first try to pack them. */
  files: TaskFilesBundle | null
}

export interface ArchiveReport extends TaskArchiveInfo {
  task_id: string
  title: string
  /** Disk freed by removing worktrees. */
  disk_bytes: number
  duration_ms: number
}

export interface RestoredWorktree {
  repo: string
  dir: string
  /** Checked out again at its branch or commit; false when it was never removed. */
  recreated: boolean
}

/** A packed folder on restore: unpacked, or left alone because something is there now. */
export interface RestoredFolder {
  dir: string
  restored: boolean
}

export interface RestoreReport {
  task_id: string
  title: string
  rows: number
  worktrees: RestoredWorktree[]
  folders: RestoredFolder[]
  duration_ms: number
}

export interface ArchivedTaskEntry extends Task {
  archive: TaskArchiveInfo
}

export interface BulkArchiveResult {
  archived: ArchiveReport[]
  refused: { task_id: string; reason: string }[]
}

/** An agent the auto-archive rule would take now. */
export interface ArchiveCandidate {
  id: string
  title: string
  idle_since: string
}

export interface AutoArchiveStatus {
  settings: AutoArchiveSettings
  /** What the rule would archive now, whether it is on or off; up to 20 listed. */
  preview: { count: number; tasks: ArchiveCandidate[] }
  archived: { count: number; stored_bytes: number; table_bytes: number; files_bytes: number }
  /** Archived agents the delete rule would delete now. */
  expired: number
}

export interface ArchiveSweepResult {
  archived: ArchiveReport[]
  failed: { task_id: string; reason: string }[]
}

/** Archived agents deleted for being archived longer than the delete rule allows. */
export interface ArchiveExpiryResult {
  deleted: { task_id: string; title: string }[]
  kept: { task_id: string; reason: string }[]
}

export const staleFoldersQuery = z.object({
  /** Folders changed more recently than this many days are left out. */
  days: z.coerce.number().int().min(0).max(AUTO_ARCHIVE_DAYS_MAX).default(STALE_FOLDER_DAYS_DEFAULT),
})

export const deleteStaleFoldersInput = z.object({
  paths: z.array(z.string().min(1)).min(1, 'pick at least one folder').max(STALE_FOLDERS_MAX),
  days: z.number().int().min(0).max(AUTO_ARCHIVE_DAYS_MAX).default(STALE_FOLDER_DAYS_DEFAULT),
  /** Deleting cannot be undone, so the caller says it means it. */
  confirm: z.literal(true, 'confirm the delete'),
})
export type DeleteStaleFoldersInput = z.input<typeof deleteStaleFoldersInput>

/** A folder in the scratch or worktree root that no agent, live or archived, owns. */
export interface StaleFolder {
  path: string
  root: 'scratch' | 'worktrees'
  bytes: number | null
  modified_at: string
  /** A checkout or a worktree of one; deleting it loses what is not pushed. */
  checkout: 'repo' | 'worktree' | null
  /** Why it cannot be deleted now, such as a process working in it; null when it can. */
  busy: string | null
}

export interface StaleFolderReport {
  roots: { scratch: string; worktrees: string }
  days: number
  folders: StaleFolder[]
  total_bytes: number
}

export interface StaleFolderDeleteResult {
  deleted: { path: string; bytes: number | null }[]
  refused: { path: string; reason: string }[]
}
