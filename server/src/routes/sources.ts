import { sourceMatchInput } from '@seti/shared'
import { Hono } from 'hono'
import { ok, validJson } from '../http.js'
import { matchSources } from '../sources/match.js'
import { requireTask } from '../tasks.js'

/** The links one of the agent's messages cites, checked against its evidence ledger. */
export const taskSourceRoutes = new Hono().post('/:id/sources', validJson(sourceMatchInput), async (c) => {
  const task = await requireTask(c.req.param('id'))
  return ok(c, await matchSources(task.id, c.req.valid('json').refs))
})
