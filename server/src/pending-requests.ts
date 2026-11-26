import type { DigestedRequest, PendingRequests, PermissionRequest, TitledRequest } from '@seti/shared'
import { tasks } from './db.js'
import { requestDigest } from './ea-authority.js'
import { changeRequests } from './store/change-requests.js'
import { knowledge } from './store/knowledge.js'
import { permissionRequests } from './store/permissions.js'
import { questions } from './store/questions.js'

async function titled<T extends { task_id: string }>(rows: readonly T[]): Promise<TitledRequest<T>[]> {
  const ids = [...new Set(rows.map((row) => row.task_id))]
  const titles = new Map(await Promise.all(ids.map(async (id) => [id, (await tasks.get(id))?.title ?? id] as const)))
  return rows.map((row) => ({ ...row, task_title: titles.get(row.task_id) ?? row.task_id }))
}

const digested = async (
  rows: readonly TitledRequest<PermissionRequest>[],
): Promise<DigestedRequest<PermissionRequest>[]> =>
  Promise.all(rows.map(async (row) => ({ ...row, digest: await requestDigest(row) })))

/**
 * Every formal request that waits on the user, of all agents or of one: open questions, access
 * changes, tool calls and plans, and the knowledge notes the agent proposed.
 */
export async function pendingRequests(taskId?: string): Promise<PendingRequests> {
  const [open, access, permissions, notes] = await Promise.all([
    questions.openList(taskId),
    changeRequests.allPending(new Date().toISOString()),
    permissionRequests.allPending(),
    knowledge.list('proposed'),
  ])
  const mine = (id: string | null) => taskId === undefined || id === taskId
  return {
    questions: open,
    access: await titled(access.filter((request) => mine(request.task_id))),
    permissions: await digested(await titled(permissions.filter((request) => mine(request.task_id)))),
    notes: notes.filter((note) => mine(note.proposer_task_id)).toReversed(),
  }
}
