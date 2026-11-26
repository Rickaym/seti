import { sourceLookupQuery, sourceMatchInput } from '@seti/shared'
import { Hono } from 'hono'
import { ok, valid, validJson } from '../http.js'
import { lookupSources } from '../sources/lookup.js'
import { matchSources } from '../sources/match.js'
import { requireTask } from '../tasks.js'

/** An agent's evidence ledger: the links one of its messages cites, checked, and a search of it. */
export const taskSourceRoutes = new Hono()
  .post('/:id/sources', validJson(sourceMatchInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    return ok(c, await matchSources(task.id, c.req.valid('json').refs))
  })
  .get('/:id/sources', valid('query', sourceLookupQuery), async (c) => {
    const task = await requireTask(c.req.param('id'))
    return ok(c, await lookupSources(task.id, c.req.valid('query')))
  })
