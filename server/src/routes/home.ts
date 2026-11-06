import { homeQuery } from '@seti/shared'
import { Hono } from 'hono'
import { homeSummary } from '../home.js'
import { ok, valid } from '../http.js'

/** The shipping metrics and live calls; a read of the database and of the runner's memory. */
export const homeRoutes = new Hono().get('/', valid('query', homeQuery), async (c) =>
  ok(c, await homeSummary(c.req.valid('query'))),
)
