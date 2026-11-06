import { accessDefaultInput } from '@seti/shared'
import { Hono } from 'hono'
import { accessCatalog, setAccessDefault } from '../agent-access.js'
import { eaSecurityAccessRefusal } from '../ea-guard.js'
import { ok, validJson } from '../http.js'

/** Every item agents may reach with its default; the EA may read them all but set only some. */
export const accessRoutes = new Hono()
  .get('/', async (c) => ok(c, await accessCatalog()))
  .put('/defaults', validJson(accessDefaultInput), async (c) => {
    const { kind, id, enabled } = c.req.valid('json')
    return eaSecurityAccessRefusal(c, [kind]) ?? ok(c, await setAccessDefault(kind, id, enabled))
  })
