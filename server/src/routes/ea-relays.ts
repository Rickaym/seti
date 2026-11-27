import { eaRelayInput, eaRelaySwitchInput } from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { sendRelay, takeBackRelay } from '../ea-relay.js'
import { setInboxRelays } from '../ea-settings.js'
import { ok, valid, validJson } from '../http.js'
import { botOnly } from './ea-state.js'

const relayParams = z.object({ id: z.coerce.number().int().positive() })

/** Inbox relays: the user's switch, the EA's one message per item, and Take back. */
export const eaRelayRoutes = new Hono()
  .put('/settings/inbox-relays', validJson(eaRelaySwitchInput), async (c) =>
    ok(c, await setInboxRelays(c.req.valid('json').on)),
  )
  .post('/relays', botOnly, validJson(eaRelayInput), async (c) => ok(c, await sendRelay(c.req.valid('json'))))
  .post('/relays/:id/take-back', valid('param', relayParams), async (c) =>
    ok(c, await takeBackRelay(c.req.valid('param').id)),
  )
