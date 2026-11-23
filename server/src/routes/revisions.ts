import { revertRevisionInput, revisionObjectRef, revisionParams, revisionQuery } from '@seti/shared'
import { Hono } from 'hono'
import { ok, valid, validJson } from '../http.js'
import { revertRevision } from '../revert.js'
import { revisions } from '../store/revisions.js'

const HISTORY_LIMIT = 100

export const revisionRoutes = new Hono()
  .get('/', valid('query', revisionQuery), async (c) => {
    const query = c.req.valid('query')
    return ok(
      c,
      'task_id' in query
        ? await revisions.forTask(query.object_type, query.task_id, HISTORY_LIMIT)
        : await revisions.list(query, HISTORY_LIMIT),
    )
  })
  .get('/unseen', async (c) => ok(c, await revisions.unseen()))
  .post('/seen', validJson(revisionObjectRef), async (c) => {
    await revisions.markSeen(c.req.valid('json'))
    return ok(c, null)
  })
  .post('/:id/revert', valid('param', revisionParams), validJson(revertRevisionInput), async (c) =>
    ok(c, await revertRevision(c.req.valid('param').id)),
  )
