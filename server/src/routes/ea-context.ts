import { eaSearchQuery } from '@seti/shared'
import { Hono } from 'hono'
import { liveContext } from '../ea-context.js'
import { indexStatus, searchIndex } from '../ea-index.js'
import { ok, valid } from '../http.js'

/** What the EA knows before each turn, and search over what tasks and PRs said. */
export const eaContextRoutes = new Hono()
  .get('/context', async (c) => ok(c, await liveContext()))
  .get('/search', valid('query', eaSearchQuery), async (c) => ok(c, await searchIndex(c.req.valid('query'))))
  .get('/index', async (c) => ok(c, await indexStatus()))
