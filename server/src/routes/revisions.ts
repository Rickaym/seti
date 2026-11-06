import { revertRevisionInput, revisionObjectRef, revisionParams } from '@seti/shared'
import { Hono } from 'hono'
import { ok, valid, validJson } from '../http.js'
import { revertRevision } from '../revert.js'
import { revisions } from '../store/revisions.js'

const HISTORY_LIMIT = 100

export const revisionRoutes = new Hono()
  .get('/', valid('query', revisionObjectRef), async (c) =>
    ok(c, await revisions.list(c.req.valid('query'), HISTORY_LIMIT)),
  )
  .get('/unseen', async (c) => ok(c, await revisions.unseen()))
  .post('/seen', validJson(revisionObjectRef), async (c) => {
    await revisions.markSeen(c.req.valid('json'))
    return ok(c, null)
  })
  .post('/:id/revert', valid('param', revisionParams), validJson(revertRevisionInput), async (c) =>
    ok(c, await revertRevision(c.req.valid('param').id)),
  )
