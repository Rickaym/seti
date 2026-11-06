import {
  connectionCreateInput,
  connectionInput,
  connectionParams,
  connectionProfilesInput,
  connectionSlotParams,
  connectionValueInput,
} from '@seti/shared'
import { Hono } from 'hono'
import {
  clearConnectionValue,
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  setConnectionProfiles,
  setConnectionValue,
  testConnectionMint,
  updateConnection,
} from '../connections.js'
import { notEa } from '../ea-guard.js'
import { ok, valid, validJson } from '../http.js'
import { settleConnection } from '../key-requests.js'

const validId = valid('param', connectionParams)
const validSlot = valid('param', connectionSlotParams)

/** Connections: settings in and out, values in only. The EA reaches none of it. */
export const connectionRoutes = new Hono()
  .use('*', notEa('see or change connections or their values'))
  .get('/', async (c) => ok(c, await listConnections()))
  .post('/', validJson(connectionCreateInput), async (c) =>
    ok(c, await settleConnection(await createConnection(c.req.valid('json')))),
  )
  .get('/:id', validId, async (c) => ok(c, await getConnection(c.req.valid('param').id)))
  .put('/:id', validId, validJson(connectionInput), async (c) =>
    ok(c, await settleConnection(await updateConnection(c.req.valid('param').id, c.req.valid('json')))),
  )
  .delete('/:id', validId, async (c) => {
    await deleteConnection(c.req.valid('param').id)
    return c.body(null, 204)
  })
  .put('/:id/values/:slot', validSlot, validJson(connectionValueInput), async (c) => {
    const { id, slot } = c.req.valid('param')
    return ok(c, await setConnectionValue(id, slot, c.req.valid('json').value))
  })
  .delete('/:id/values/:slot', validSlot, async (c) => {
    const { id, slot } = c.req.valid('param')
    return ok(c, await clearConnectionValue(id, slot))
  })
  .put('/:id/credentials', validId, validJson(connectionProfilesInput), async (c) =>
    ok(
      c,
      await settleConnection(await setConnectionProfiles(c.req.valid('param').id, c.req.valid('json').profile_ids)),
    ),
  )
  .post('/:id/test', validId, async (c) => ok(c, await testConnectionMint(c.req.valid('param').id)))
