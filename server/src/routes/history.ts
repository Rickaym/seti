import { agentActivityQuery, transcriptWindowQuery } from '@seti/shared'
import { Hono } from 'hono'
import { agentActivity, readTranscript } from '../history.js'
import { ok, valid } from '../http.js'
import { requireTask } from '../tasks.js'

/** What agents did in a time window: every agent's activity, or one agent's transcript. */
export const historyRoutes = new Hono()
  .get('/activity', valid('query', agentActivityQuery), async (c) => ok(c, await agentActivity(c.req.valid('query'))))
  .get('/tasks/:id', valid('query', transcriptWindowQuery), async (c) =>
    ok(c, await readTranscript(await requireTask(c.req.param('id')), c.req.valid('query'))),
  )
