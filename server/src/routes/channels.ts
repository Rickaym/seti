import {
  channelCreateInput,
  channelFilterInput,
  channelModeInput,
  channelRotateInput,
  channelSubscribeInput,
  channelUpdateInput,
} from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { pollerRoutes } from './pollers.js'
import { reminderRoutes } from './reminders.js'
import {
  createChannel,
  deleteChannel,
  listChannels,
  revealChannelSecret,
  rotateChannel,
  SECRET_VALUES,
  setChannelFilter,
  setChannelMode,
  subscribeChannel,
  unsubscribeChannel,
  updateChannel,
} from '../channels/actions.js'
import { channelsSummary } from '../channels/health.js'
import { webhooks } from '../channels/service.js'
import { HOOK_ID } from '../channels/signature.js'
import { channelSources } from '../channels/source-info.js'
import { subscriptions } from '../channels/subscriptions.js'
import { fromEa, notEa, refuseEa } from '../ea-guard.js'
import { ok, valid, validJson } from '../http.js'

const idParam = z.object({ id: z.string().regex(HOOK_ID) })
const subscriptionParam = idParam.extend({ sub: z.coerce.number().int().positive() })

/** Webhooks, pollers and reminders: settings, events, deliveries; secrets once, never to the EA. */
export const channelRoutes = new Hono()
  .get('/', async (c) => ok(c, await listChannels()))
  .get('/summary', async (c) => ok(c, await channelsSummary()))
  .get('/sources', (c) => ok(c, channelSources()))
  .route('/pollers', pollerRoutes)
  .route('/reminders', reminderRoutes)
  .post('/', validJson(channelCreateInput), async (c) => {
    const input = c.req.valid('json')
    if (fromEa() && input.secret !== undefined) {
      return refuseEa(c, SECRET_VALUES)
    }
    return ok(c, await createChannel(input))
  })
  .put('/:id', valid('param', idParam), validJson(channelUpdateInput), async (c) =>
    ok(c, await updateChannel(c.req.valid('param').id, c.req.valid('json'))),
  )
  .post('/:id/rotate', valid('param', idParam), validJson(channelRotateInput), async (c) => {
    const given = c.req.valid('json').secret
    if (fromEa() && given !== undefined) {
      return refuseEa(c, SECRET_VALUES)
    }
    return ok(c, await rotateChannel(c.req.valid('param').id, given))
  })
  .post('/:id/reveal', notEa(SECRET_VALUES), valid('param', idParam), async (c) =>
    ok(c, await revealChannelSecret(c.req.valid('param').id)),
  )
  .delete('/:id', valid('param', idParam), async (c) => {
    const { id } = c.req.valid('param')
    await deleteChannel(id)
    return ok(c, { id })
  })
  .post('/:id/test', valid('param', idParam), async (c) => ok(c, await webhooks.sendTest(c.req.valid('param').id)))
  .get('/:id/subscriptions', valid('param', idParam), async (c) =>
    ok(c, await subscriptions.list(c.req.valid('param').id)),
  )
  .post('/:id/subscriptions', valid('param', idParam), validJson(channelSubscribeInput), async (c) =>
    ok(c, await subscribeChannel(c.req.valid('param').id, c.req.valid('json'))),
  )
  .put('/:id/subscriptions/:sub', valid('param', subscriptionParam), validJson(channelFilterInput), async (c) => {
    const { id, sub } = c.req.valid('param')
    return ok(c, await setChannelFilter(id, sub, c.req.valid('json').events))
  })
  .put('/:id/subscriptions/:sub/mode', valid('param', subscriptionParam), validJson(channelModeInput), async (c) => {
    const { id, sub } = c.req.valid('param')
    return ok(c, await setChannelMode(id, sub, c.req.valid('json').mode))
  })
  .delete('/:id/subscriptions/:sub', valid('param', subscriptionParam), async (c) => {
    const { id, sub } = c.req.valid('param')
    return ok(c, await unsubscribeChannel(id, sub))
  })

/** Mounted beside taskRoutes under /api/tasks: the channels a task subscribes to. */
export const taskChannelRoutes = new Hono().get('/:id/channels', async (c) =>
  ok(c, await subscriptions.forTask(c.req.param('id'))),
)

/** Mounted under /api/ea: the channels whose events reach the EA's inbox. */
export const eaChannelRoutes = new Hono().get('/channels', async (c) => ok(c, await subscriptions.forEa()))
