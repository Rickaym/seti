import { importSessionInput, importSessionsInput, sessionListQuery, sessionParams } from '@seti/shared'
import { Hono } from 'hono'
import { ok, valid, validJson } from '../http.js'
import { sessionService } from '../sessions.js'

export const sessionRoutes = new Hono()
  .get('/', valid('query', sessionListQuery), async (c) => ok(c, await sessionService.list(c.req.valid('query'))))
  .post('/import', validJson(importSessionsInput), async (c) =>
    ok(c, await sessionService.importMany(c.req.valid('json').sessions)),
  )
  .get('/:id', valid('param', sessionParams), async (c) => ok(c, await sessionService.detail(c.req.valid('param').id)))
  .post('/:id/import', valid('param', sessionParams), validJson(importSessionInput), async (c) =>
    ok(c, await sessionService.importSession(c.req.valid('param').id, c.req.valid('json'))),
  )
