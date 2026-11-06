import { performance } from 'node:perf_hooks'
import {
  isComplete,
  prStates,
  type ArchiveCandidate,
  type ArchivedTaskEntry,
  type ArchiveReport,
  type ArchiveSweepResult,
  type AuditActor,
  type AutoArchiveInput,
  type AutoArchiveSettings,
  type AutoArchiveStatus,
  type MessagePage,
  type MessageRow,
  type RestoreReport,
  type Task,
} from '@seti/shared'
import { decodeChunk, type StoredMessage } from './archive-codec.js'
import { bundleTaskFiles, unpackTaskFiles, type Unpacked } from './archive-files.js'
import { freeWorktrees, recreateWorktrees } from './archive-worktrees.js'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { capabilityCache } from './capabilities.js'
import { tasks, toMessage } from './db.js'
import { HttpError } from './http.js'
import { endSession, isRunning, publish, sessionState } from './runner.js'
import { shellTurnGuard } from './shell-context.js'
import { closeAgentChats } from './side-chat/chats.js'
import { archiveSettings, taskArchives, type ArchiveRecord } from './store/archive.js'
import { taskInputs } from './store/inputs.js'
import { prWatch } from './store/pr-watch.js'
import { teamMessages } from './store/team.js'
import { storedFields } from './stored-rows.js'
import { forgetSubtasks } from './subtask-cache.js'
import { inLane } from './task-lane.js'
import { requireTask } from './tasks.js'
import { endAgentTerminals } from './terminal.js'

const DAY_MS = 24 * 60 * 60 * 1000
const SWEEP_MS = 60 * 60 * 1000
const SWEEP_DELAY_MS = 60 * 1000
const PREVIEW_LISTED = 20
const CHUNKS_CACHED = 16

type ArchiveActor = Extract<AuditActor, 'user' | 'system'>

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  return `${String(Math.ceil(bytes / 1024))} KB`
}

/** Why the task cannot be archived now, or null when it can. */
function busyReason(taskId: string): string | null {
  if (isRunning(taskId)) {
    return 'The agent is working on a turn; stop it first'
  }
  if (sessionState(taskId).background > 0) {
    return 'The agent has background work running; stop it first'
  }
  return shellTurnGuard(taskId)
}

const chunkCache = new Map<string, StoredMessage[]>()

function forgetChunks(taskId: string): void {
  for (const key of chunkCache.keys()) {
    if (key.startsWith(`${taskId}:`)) {
      chunkCache.delete(key)
    }
  }
}

async function chunkRows(record: ArchiveRecord, index: number): Promise<StoredMessage[]> {
  const key = `${record.task_id}:${record.sha256}:${String(index)}`
  const cached = chunkCache.get(key)
  if (cached !== undefined) {
    chunkCache.delete(key)
    chunkCache.set(key, cached)
    return cached
  }
  const ref = record.chunks[index]
  const bytes = ref === undefined ? undefined : await taskArchives.chunk(record.task_id, ref)
  if (bytes === undefined) {
    return []
  }
  const rows = await decodeChunk(record.codec, bytes)
  chunkCache.set(key, rows)
  for (const oldest of chunkCache.keys()) {
    if (chunkCache.size <= CHUNKS_CACHED) {
      break
    }
    chunkCache.delete(oldest)
  }
  return rows
}

const toRow = (taskId: string, row: StoredMessage): MessageRow => toMessage({ ...row, task_id: taskId })

/** Matches the live page: no subagent messages and no per-step progress reports. */
function isOwnRow(row: StoredMessage): boolean {
  const fields = row.kind === 'sdk' ? storedFields(row.payload) : {}
  return (fields.parent_tool_use_id ?? null) === null && fields.subtype !== 'task_progress'
}

/** A page of an archived transcript, decompressing only the chunks it needs. */
export async function archivedPage(
  taskId: string,
  limit: number,
  before = Number.MAX_SAFE_INTEGER,
): Promise<MessagePage> {
  const record = await taskArchives.get(taskId)
  if (!record) {
    return { messages: [], has_older: false }
  }
  let page: MessageRow[] = []
  for (let index = record.chunks.length - 1; index >= 0 && page.length < limit; index -= 1) {
    if ((record.chunks[index]?.first_id ?? before) < before) {
      const own = (await chunkRows(record, index)).filter((row) => row.id < before && isOwnRow(row))
      const rows = own.map((row) => toRow(taskId, row))
      page = [...rows.slice(Math.max(0, rows.length - (limit - page.length))), ...page]
    }
  }
  const oldest = page[0]?.id ?? before
  return { messages: page, has_older: record.chunks.some((chunk) => chunk.first_id < oldest) }
}

export async function archivedMessage(taskId: string, id: number): Promise<MessageRow | undefined> {
  const record = await taskArchives.get(taskId)
  const index = record?.chunks.findIndex((chunk) => chunk.first_id <= id && id <= chunk.last_id) ?? -1
  if (!record || index < 0) {
    return undefined
  }
  const row = (await chunkRows(record, index)).find((candidate) => candidate.id === id)
  return row && toRow(taskId, row)
}

interface ArchiveOptions {
  actor: ArchiveActor
  removeWorktree: boolean
  /** Set when the auto-archive rule took the task, with its days. */
  ruleDays?: number
}

async function auditArchived(report: ArchiveReport, options: ArchiveOptions): Promise<void> {
  const disk = report.disk_bytes > 0 ? `, freed ${formatBytes(report.disk_bytes)} of disk` : ''
  const why = options.ruleDays === undefined ? '' : ` (COMPLETE and idle ${String(options.ruleDays)}+ days)`
  const sizes = `${formatBytes(report.table_bytes)} to ${formatBytes(report.stored_bytes)}`
  await audit.record({
    actor: options.actor,
    kind: 'task.archived',
    subject_type: 'task',
    subject_id: report.task_id,
    summary: `Archived agent "${report.title}"${why}: ${String(report.rows)} transcript rows, ${sizes}${disk}`,
    detail: {
      title: report.title,
      rows: report.rows,
      raw_bytes: report.raw_bytes,
      stored_bytes: report.stored_bytes,
      table_bytes: report.table_bytes,
      disk_bytes: report.disk_bytes,
      codec: report.codec,
      removed_worktrees: report.worktrees.filter((w) => w.removed).map((w) => w.dir),
      kept_worktrees: report.worktrees.filter((w) => !w.removed).map((w) => `${w.dir}: ${w.kept_because ?? ''}`),
      ...(options.ruleDays === undefined ? {} : { rule: 'auto_archive', rule_days: options.ruleDays }),
    },
  })
}

/**
 * Closes the task's session, moves its transcript into a compressed archive and frees its
 * worktree when nothing would be lost. Refuses a task that is working.
 */
export async function archiveTask(taskId: string, options: ArchiveOptions): Promise<ArchiveReport> {
  const started = performance.now()
  const task = await requireTask(taskId)
  if (task.archived_at !== null) {
    throw new HttpError(409, `Agent "${task.title}" is already archived`)
  }
  const busy = busyReason(task.id)
  if (busy !== null) {
    throw new HttpError(409, busy)
  }
  await endSession(task.id)
  endAgentTerminals(task.id, 'archived')
  closeAgentChats(task.id)
  const { record, worktrees } = await inLane(task.id, async () => {
    if (isRunning(task.id) || sessionState(task.id).open) {
      throw new HttpError(409, 'The agent started working again; stop it first')
    }
    const archived = await taskArchives.archive(task.id, options.actor)
    if (archived === null) {
      throw new HttpError(409, `Agent "${task.title}" is already archived`)
    }
    const freed = await freeWorktrees(task, options.removeWorktree)
    if (freed.length > 0) {
      await taskArchives.setWorktrees(task.id, freed)
    }
    return { record: archived, worktrees: freed }
  })
  forgetSubtasks(task.id)
  forgetChunks(task.id)
  publish(task.id, { type: 'archived', archived: true })
  const report: ArchiveReport = {
    task_id: task.id,
    title: task.title,
    archived_at: record.archived_at,
    actor: record.actor,
    codec: record.codec,
    rows: record.rows,
    raw_bytes: record.raw_bytes,
    stored_bytes: record.stored_bytes,
    table_bytes: record.table_bytes,
    worktrees,
    files: null,
    disk_bytes: worktrees.reduce((sum, worktree) => sum + (worktree.bytes ?? 0), 0),
    duration_ms: Math.round(performance.now() - started),
  }
  await auditArchived(report, options)
  inBackground('archive files', async () => bundleTaskFiles(task.id))
  return report
}

/** Puts the transcript back with its ids and recreates removed worktrees; the agent is idle. */
export async function unarchiveTask(taskId: string, actor: ArchiveActor = 'user'): Promise<RestoreReport> {
  const started = performance.now()
  const task = await requireTask(taskId)
  if (task.archived_at === null) {
    throw new HttpError(409, `Agent "${task.title}" is not archived`)
  }
  const { rows, worktrees, folders } = await inLane(task.id, async () => {
    const record = await taskArchives.get(task.id)
    if (!record) {
      throw new HttpError(409, `Agent "${task.title}" is not archived`)
    }
    const recreated = await recreateWorktrees(record.worktrees)
    let unpacked: Unpacked
    try {
      unpacked = await unpackTaskFiles(task.id, record)
    } catch (e) {
      await recreated.undo()
      throw new HttpError(409, `Could not unpack the agent's folders: ${errorText(e)}`)
    }
    try {
      const restored = await taskArchives.restore(task.id)
      await unpacked.finish().catch((e: unknown) => {
        process.stderr.write(`archive: kept the bundle of ${task.id}: ${errorText(e)}\n`)
      })
      return { rows: restored?.rows ?? 0, worktrees: recreated.restored, folders: unpacked.folders }
    } catch (e) {
      await unpacked.undo()
      await recreated.undo()
      throw e
    }
  })
  forgetSubtasks(task.id)
  forgetChunks(task.id)
  capabilityCache.prewarm(task.cwd)
  publish(task.id, { type: 'archived', archived: false })
  const again = worktrees.filter((worktree) => worktree.recreated).map((worktree) => worktree.dir)
  const recreatedText = again.length === 0 ? '' : `, recreated ${String(again.length)} worktree(s)`
  const unpackedDirs = folders.filter((folder) => folder.restored).map((folder) => folder.dir)
  const unpackedText = unpackedDirs.length === 0 ? '' : `, unpacked ${String(unpackedDirs.length)} folder(s)`
  await audit.record({
    actor,
    kind: 'task.unarchived',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Restored agent "${task.title}": ${String(rows)} transcript rows${recreatedText}${unpackedText}`,
    detail: { title: task.title, rows, recreated_worktrees: again, unpacked_folders: unpackedDirs },
  })
  const duration = Math.round(performance.now() - started)
  return { task_id: task.id, title: task.title, rows, worktrees, folders, duration_ms: duration }
}

export async function listArchived(): Promise<ArchivedTaskEntry[]> {
  const [list, archives] = await Promise.all([tasks.listArchived(), taskArchives.list()])
  return list.flatMap((task) => {
    const record = archives.get(task.id)
    if (!record) {
      return []
    }
    const { archived_at, actor, codec, rows, raw_bytes, stored_bytes, table_bytes, worktrees, files } = record
    const archive = { archived_at, actor, codec, rows, raw_bytes, stored_bytes, table_bytes, worktrees, files }
    return [{ ...task, archive }]
  })
}

/** Why the rule leaves a COMPLETE, long idle task alone, or null when it would archive it. */
async function ruleBlocker(task: Task): Promise<string | null> {
  const busy = busyReason(task.id)
  if (busy !== null) {
    return busy
  }
  if ((await taskInputs.pending(task.id, 1)).length > 0) {
    return 'updates wait for the agent'
  }
  return (await teamMessages.mentionsAfter(task.id, task.updated_at)) ? 'the group chat mentioned it since' : null
}

/** Unpinned COMPLETE agents idle for at least `days` that nothing waits on, oldest first. */
export async function autoArchiveCandidates(days: number, at = Date.now()): Promise<ArchiveCandidate[]> {
  const cutoff = new Date(at - days * DAY_MS).toISOString()
  const [list, states] = await Promise.all([tasks.list(), prWatch.allTaskStates()])
  const candidates: ArchiveCandidate[] = []
  for (const task of list) {
    if (
      !task.pinned &&
      task.updated_at <= cutoff &&
      isComplete(task, prStates(states.get(task.id) ?? {})) &&
      (await ruleBlocker(task)) === null
    ) {
      candidates.push({ id: task.id, title: task.title, idle_since: task.updated_at })
    }
  }
  return candidates.sort((a, b) => a.idle_since.localeCompare(b.idle_since))
}

/** Unpinned archived agents archived at least `days` ago, oldest first. */
export async function expiredArchives(days: number | null, at = Date.now()): Promise<ArchivedTaskEntry[]> {
  if (days === null) {
    return []
  }
  const cutoff = new Date(at - days * DAY_MS).toISOString()
  return (await listArchived())
    .filter((task) => !task.pinned && task.archive.archived_at <= cutoff)
    .sort((a, b) => a.archive.archived_at.localeCompare(b.archive.archived_at))
}

/** The rule as saved, and what it would archive now with its days or with `days` instead. */
export async function autoArchiveStatus(days?: number, at = Date.now()): Promise<AutoArchiveStatus> {
  const settings = await archiveSettings.get()
  const candidates = await autoArchiveCandidates(days ?? settings.days, at)
  return {
    settings,
    preview: { count: candidates.length, tasks: candidates.slice(0, PREVIEW_LISTED) },
    archived: await taskArchives.totals(),
    expired: (await expiredArchives(settings.delete_after_days, at)).length,
  }
}

const dayWords = (days: number) => (days === 1 ? '1 day' : `${String(days)} days`)

function ruleWords(settings: AutoArchiveSettings, before: AutoArchiveSettings): string {
  const archive = settings.enabled ? `on, for COMPLETE agents idle ${dayWords(settings.days)} or more` : 'off'
  const turned = settings.resume_after_restart ? 'on' : 'off'
  const resume = settings.resume_after_restart === before.resume_after_restart ? '' : `; resume after restart ${turned}`
  if (settings.delete_after_days !== null) {
    return `${archive}; delete archived agents after ${dayWords(settings.delete_after_days)}${resume}`
  }
  return before.delete_after_days === null ? `${archive}${resume}` : `${archive}; keep archived agents${resume}`
}

const SETTING_KEYS = ['enabled', 'days', 'delete_after_days', 'resume_after_restart'] as const

/** Saves the fields the input carries and keeps the rest. */
export async function updateAutoArchive(input: AutoArchiveInput): Promise<AutoArchiveSettings> {
  const before = await archiveSettings.get()
  const after = await archiveSettings.set({
    enabled: input.enabled ?? before.enabled,
    days: input.days ?? before.days,
    delete_after_days: input.delete_after_days === undefined ? before.delete_after_days : input.delete_after_days,
    resume_after_restart: input.resume_after_restart ?? before.resume_after_restart,
  })
  if (SETTING_KEYS.some((key) => before[key] !== after[key])) {
    await audit.record({
      actor: 'user',
      kind: 'system.auto_archive_changed',
      subject_type: 'system',
      summary: `Set auto archive ${ruleWords(after, before)}`,
      detail: {
        enabled: after.enabled,
        days: after.days,
        delete_after_days: after.delete_after_days,
        resume_after_restart: after.resume_after_restart,
        was_enabled: before.enabled,
        was_days: before.days,
        was_delete_after_days: before.delete_after_days,
        was_resume_after_restart: before.resume_after_restart,
      },
    })
  }
  return after
}

let sweeping: Promise<ArchiveSweepResult> | null = null

async function sweep(actor: ArchiveActor, at: number): Promise<ArchiveSweepResult> {
  const result: ArchiveSweepResult = { archived: [], failed: [] }
  const settings = await archiveSettings.get()
  if (!settings.enabled && actor === 'system') {
    return result
  }
  for (const candidate of await autoArchiveCandidates(settings.days, at)) {
    try {
      result.archived.push(await archiveTask(candidate.id, { actor, removeWorktree: true, ruleDays: settings.days }))
    } catch (e) {
      result.failed.push({ task_id: candidate.id, reason: errorText(e) })
    }
  }
  return result
}

/**
 * Archives what the rule matches now: on its schedule as the system while the rule is on, or
 * when the user asks, whether it is on or not. One sweep runs at a time.
 */
export async function sweepAutoArchive(actor: ArchiveActor = 'system', at = Date.now()): Promise<ArchiveSweepResult> {
  sweeping ??= sweep(actor, at).finally(() => {
    sweeping = null
  })
  return sweeping
}

export function startAutoArchive(): void {
  const run = () => {
    sweepAutoArchive().catch((e: unknown) => {
      process.stderr.write(`auto archive: ${errorText(e)}\n`)
    })
  }
  setTimeout(run, SWEEP_DELAY_MS).unref()
  setInterval(run, SWEEP_MS).unref()
}
