import { pollerCreateInput, pollerTestInput, pollerUpdateInput } from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { HOOK_ID } from '../channels/signature.js'
import { pollerSecretRefs } from '../connection-values.js'
import { fromEa, refuseEa } from '../ea-guard.js'
import { ok, valid, validJson } from '../http.js'
import { createPoller, pollerRefusal, pollNow, testPoller, updatePoller } from '../pollers/actions.js'
import { pollers } from '../pollers/service.js'

const idParam = z.object({ id: z.string().regex(HOOK_ID) })
const RUN_HISTORY = 10

/** Pollers: Seti runs their scripts on a schedule; only the user widens what they reach. */
export const pollerRoutes = new Hono()
  .get('/secrets', async (c) => ok(c, await pollerSecretRefs()))
  .post('/', validJson(pollerCreateInput), async (c) => {
    const input = c.req.valid('json')
    const refusal = fromEa() ? pollerRefusal(input, undefined) : null
    if (refusal !== null) {
      return refuseEa(c, refusal)
    }
    return ok(c, await createPoller(input))
  })
  .post('/test', validJson(pollerTestInput), async (c) => {
    const input = c.req.valid('json')
    const saved = input.channel_id === undefined ? undefined : await pollers.get(input.channel_id)
    const refusal = fromEa() ? pollerRefusal(input, saved) : null
    if (refusal !== null) {
      return refuseEa(c, refusal)
    }
    return ok(c, await testPoller(input))
  })
  .get('/:id', valid('param', idParam), async (c) => ok(c, await pollers.info(c.req.valid('param').id)))
  .put('/:id', valid('param', idParam), validJson(pollerUpdateInput), async (c) => {
    const { id } = c.req.valid('param')
    const change = c.req.valid('json')
    const refusal = fromEa() ? pollerRefusal(change, await pollers.get(id)) : null
    if (refusal !== null) {
      return refuseEa(c, refusal)
    }
    return ok(c, await updatePoller(id, change))
  })
  .post('/:id/poll', valid('param', idParam), async (c) => ok(c, await pollNow(c.req.valid('param').id)))
  .get('/:id/runs', valid('param', idParam), async (c) =>
    ok(c, await pollers.runs(c.req.valid('param').id, RUN_HISTORY)),
  )
