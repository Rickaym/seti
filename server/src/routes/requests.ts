import { requestListQuery } from '@seti/shared'
import { Hono } from 'hono'
import { ok, valid } from '../http.js'
import { pendingRequests } from '../pending-requests.js'

/**
 * Every request that waits on the user, under /api/requests. It only lists them: each kind is
 * answered on its own route, where access, tool calls, plans and notes stay the user's.
 */
export const requestRoutes = new Hono().get('/', valid('query', requestListQuery), async (c) =>
  ok(c, await pendingRequests(c.req.valid('query').task_id)),
)
