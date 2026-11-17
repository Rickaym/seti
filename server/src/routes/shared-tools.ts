import { sharedToolParams, sharedToolUpdateInput } from '@seti/shared'
import { Hono } from 'hono'
import { ok, valid, validJson } from '../http.js'
import { listSharedTools, removeSharedTool, setSharedToolEnabled, sharedToolCode } from '../shared-tools.js'

const validName = valid('param', sharedToolParams)

/** The shared tools the user allowed: their list, one tool's code, its switch and its removal. */
export const sharedToolRoutes = new Hono()
  .get('/', async (c) => ok(c, await listSharedTools()))
  .get('/:name', validName, async (c) => ok(c, await sharedToolCode(c.req.valid('param').name)))
  .patch('/:name', validName, validJson(sharedToolUpdateInput), async (c) =>
    ok(c, await setSharedToolEnabled(c.req.valid('param').name, c.req.valid('json').enabled)),
  )
  .delete('/:name', validName, async (c) => {
    await removeSharedTool(c.req.valid('param').name)
    return c.body(null, 204)
  })
