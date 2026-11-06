import type { Task, TaskDigest } from '@seti/shared'
import { archivedPage } from './archive.js'
import { auditTask } from './audit.js'
import { messages } from './db.js'
import { buildDigest } from './digest.js'
import { hideDirect } from './direct-privacy.js'
import { openQuerySince, stopTurn } from './runner.js'
import { subtaskBriefs } from './subtask-cache.js'
import { requireTask } from './tasks.js'

/** Most rows yield no line or share one with a tool result, so read several rows per line. */
const DIGEST_ROWS_PER_LINE = 6
const DIGEST_ROWS_MAX = 1200

/** A page of the task's transcript as the reader may see it, from its archive while archived. */
export async function transcriptPage(id: string, limit: number, before?: number) {
  const task = await requireTask(id)
  const page =
    task.archived_at === null ? await messages.page(task.id, limit, before) : await archivedPage(task.id, limit, before)
  return { ...page, messages: await hideDirect(task.id, page.messages) }
}

/** The task's recent transcript condensed to one line per step. */
export async function taskDigest(id: string, limit: number): Promise<TaskDigest> {
  const rows = (await transcriptPage(id, Math.min(limit * DIGEST_ROWS_PER_LINE, DIGEST_ROWS_MAX))).messages
  const subtasks = await subtaskBriefs(id, openQuerySince(id))
  return { lines: buildDigest(rows, subtasks).slice(-limit) }
}

/** Stops the running turn; its queued messages are taken back unless they are to be delivered. */
export async function stopTask(id: string, options: { deliverQueued?: boolean } = {}): Promise<Task> {
  await stopTurn(id, options)
  await auditTask('task.stopped', await requireTask(id))
  return requireTask(id)
}
