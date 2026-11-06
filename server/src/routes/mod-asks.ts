import { modAskDecisionInput, modAskParams } from '@seti/shared'
import { Hono } from 'hono'
import { ok, valid, validJson } from '../http.js'
import { decideModAsk, openModAsks } from '../mods/asks.js'

/** What mods asked the user to allow; only the user's own session or local token answers. */
export const modAskRoutes = new Hono()
  .get('/', async (c) => ok(c, await openModAsks()))
  .post('/:id', valid('param', modAskParams), validJson(modAskDecisionInput), async (c) =>
    ok(c, await decideModAsk(c.req.valid('param').id, c.req.valid('json').decision)),
  )
