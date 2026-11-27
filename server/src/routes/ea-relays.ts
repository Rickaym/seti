import { eaAssignSkipInput, eaRelayInput, eaRelaySwitchInput } from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { addAssignSkip, removeAssignSkip } from '../ea-assign-skips.js'
import { sendRelay, takeBackRelay } from '../ea-relay.js'
import { setInboxRelays } from '../ea-settings.js'
import { ok, valid, validJson } from '../http.js'
import { assignSkips } from '../store/ea-relays.js'
import { botOnly } from './ea-state.js'

const relayParams = z.object({ id: z.coerce.number().int().positive() })

/** Assign (EA-19): the user's switch, the EA's one assignment per item, Take back and skips. */
export const eaRelayRoutes = new Hono()
  .put('/settings/inbox-relays', validJson(eaRelaySwitchInput), async (c) =>
    ok(c, await setInboxRelays(c.req.valid('json').on)),
  )
  .post('/relays', botOnly, validJson(eaRelayInput), async (c) => ok(c, await sendRelay(c.req.valid('json'))))
  .post('/relays/:id/take-back', valid('param', relayParams), async (c) =>
    ok(c, await takeBackRelay(c.req.valid('param').id)),
  )
  .get('/assign-skips', async (c) => ok(c, await assignSkips.list()))
  .post('/assign-skips', validJson(eaAssignSkipInput), async (c) => ok(c, await addAssignSkip(c.req.valid('json'))))
  .post('/assign-skips/remove', validJson(eaAssignSkipInput), async (c) =>
    ok(c, await removeAssignSkip(c.req.valid('json'))),
  )
