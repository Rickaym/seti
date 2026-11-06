import { Hono } from 'hono'
import { receiver } from '../channels/service.js'
import { fail, ok } from '../http.js'

/** Webhook deliveries; each request proves itself with its channel's signature, not with Access. */
export const hookRoutes = new Hono()
  .use('*', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })
  .post('/:id', async (c) => {
    const result = await receiver.receive(c.req.param('id'), c.req.raw)
    if (result.retryAfterS !== undefined) {
      c.header('Retry-After', String(result.retryAfterS))
    }
    if (result.http >= 400) {
      return fail(c, result.http, result.status === 'not_found' ? 'Not found' : 'Refused', result.reason)
    }
    return ok(c, { status: result.status, reason: result.reason })
  })
  .all('*', (c) => fail(c, 404, 'Not found'))
