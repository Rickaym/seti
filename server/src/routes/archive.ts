import {
  archivedRefusal,
  archiveTaskInput,
  autoArchiveInput,
  autoArchivePreviewQuery,
  bulkArchiveInput,
  deleteStaleFoldersInput,
  isRecord,
  staleFoldersQuery,
  type BulkArchiveResult,
} from '@seti/shared'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import {
  archiveTask,
  autoArchiveStatus,
  listArchived,
  sweepAutoArchive,
  unarchiveTask,
  updateAutoArchive,
} from '../archive.js'
import { tasks } from '../db.js'
import { fail, ok, valid, validJson } from '../http.js'
import { deleteStaleFolders, staleFolders } from '../stale-folders.js'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Mounted on /api/tasks before the task routes, so `archived` never reads as a task id. */
export const taskArchiveRoutes = new Hono()
  .get('/archived', async (c) => ok(c, await listArchived()))
  .post('/archive', validJson(bulkArchiveInput), async (c) => {
    const { task_ids: ids, remove_worktree: removeWorktree } = c.req.valid('json')
    const result: BulkArchiveResult = { archived: [], refused: [] }
    for (const id of new Set(ids)) {
      try {
        result.archived.push(await archiveTask(id, { actor: 'user', removeWorktree }))
      } catch (e) {
        result.refused.push({ task_id: id, reason: errorText(e) })
      }
    }
    return ok(c, result)
  })
  .post('/:id/archive', validJson(archiveTaskInput), async (c) =>
    ok(c, await archiveTask(c.req.param('id'), { actor: 'user', removeWorktree: c.req.valid('json').remove_worktree })),
  )
  .post('/:id/unarchive', async (c) => ok(c, await unarchiveTask(c.req.param('id'))))

export const archiveRoutes = new Hono()
  .get('/settings', valid('query', autoArchivePreviewQuery), async (c) =>
    ok(c, await autoArchiveStatus(c.req.valid('query').days)),
  )
  .put('/settings', validJson(autoArchiveInput), async (c) => {
    await updateAutoArchive(c.req.valid('json'))
    return ok(c, await autoArchiveStatus())
  })
  .post('/sweep', async (c) => ok(c, await sweepAutoArchive('user')))
  .get('/stale-folders', valid('query', staleFoldersQuery), async (c) =>
    ok(c, await staleFolders(c.req.valid('query').days)),
  )
  .post('/stale-folders/delete', validJson(deleteStaleFoldersInput), async (c) =>
    ok(c, await deleteStaleFolders(c.req.valid('json'))),
  )

const OPEN_WHILE_ARCHIVED = /\/(?:archive|unarchive)$/

/** A change that only moves the agent to another workspace; Hono keeps the body for the route. */
async function onlyMoves(c: Context): Promise<boolean> {
  const body: unknown = await c.req.json().catch(() => null)
  return isRecord(body) && Object.keys(body).length === 1 && 'workspace_id' in body
}

/** Refuses every change to an archived task except restoring, moving and deleting it; reads pass. */
export const archivedGuard: MiddlewareHandler = async (c, next) => {
  const method = c.req.method
  const onTask = c.req.path === `/api/tasks/${c.req.param('id') ?? ''}`
  const isDelete = method === 'DELETE' && onTask
  const isMove = method === 'PATCH' && onTask && (await onlyMoves(c))
  if (method === 'GET' || isDelete || isMove || OPEN_WHILE_ARCHIVED.test(c.req.path)) {
    await next()
    return undefined
  }
  const task = await tasks.get(c.req.param('id') ?? '')
  if (task !== undefined && task.archived_at !== null) {
    return fail(c, 409, 'Archived', archivedRefusal(task.title))
  }
  await next()
  return undefined
}
