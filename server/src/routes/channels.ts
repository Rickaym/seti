import {
  channelCreateInput,
  subscriptionDeliveryInput,
  channelFilterInput,
  channelModeInput,
  channelRotateInput,
  channelSubscribeInput,
  channelUpdateInput,
  senderSampleInput,
  webhookFilterInput,
  webhookFilterTestInput,
  slackNamesQuery,
  webhookThreadsInput,
} from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  checkSenderSample,
  createChannel,
  deleteChannel,
  listChannels,
  revealChannelSecret,
  rotateChannel,
  SECRET_VALUES,
  SENDER_RULES,
  setChannelDelivery,
  setChannelFilter,
  setChannelMode,
  subscribeChannel,
  unsubscribeChannel,
  updateChannel,
} from '../channels/actions.js'
import { setWebhookFilter } from '../channels/filter-actions.js'
import { testFilter } from '../channels/filter-test.js'
import { channelsSummary } from '../channels/health.js'
import { webhooks } from '../channels/service.js'
import { HOOK_ID } from '../channels/signature.js'
import { channelSources } from '../channels/source-info.js'
import { subscriptions } from '../channels/subscriptions.js'
import { fromEa, notEa, refuseEa } from '../ea-guard.js'
import { ok, valid, validJson } from '../http.js'
import { slackNames } from '../store/slack-names.js'
import { threadFollows } from '../store/threads.js'
import { requireTask } from '../tasks.js'
import { setWebhookThreads, THREAD_SWITCHES } from '../threads/actions.js'
import { stopFollowing } from '../threads/stop.js'
import { pollerRoutes } from './pollers.js'
import { reminderRoutes } from './reminders.js'

const idParam = z.object({ id: z.string().regex(HOOK_ID) })
const subscriptionParam = idParam.extend({ sub: z.coerce.number().int().positive() })
const threadParam = z.object({ id: z.string().min(1), follow: z.coerce.number().int().positive() })

/** Webhooks, pollers and reminders: settings, events, deliveries; secrets once, never to the EA. */
export const channelRoutes = new Hono()
  .get('/', async (c) => ok(c, await listChannels()))
  .get('/summary', async (c) => ok(c, await channelsSummary()))
  .get('/sources', (c) => ok(c, channelSources()))
  .get('/slack-names', valid('query', slackNamesQuery), async (c) =>
    ok(c, Object.fromEntries(await slackNames.of(c.req.valid('query').ids))),
  )
  .route('/pollers', pollerRoutes)
  .route('/reminders', reminderRoutes)
  .post('/', validJson(channelCreateInput), async (c) => {
    const input = c.req.valid('json')
    if (fromEa() && input.secret !== undefined) {
      return refuseEa(c, SECRET_VALUES)
    }
    if (fromEa() && input.sender !== undefined) {
      return refuseEa(c, SENDER_RULES)
    }
    return ok(c, await createChannel(input))
  })
  .post('/sample', notEa(SECRET_VALUES), validJson(senderSampleInput), async (c) =>
    ok(c, await checkSenderSample(c.req.valid('json'))),
  )
  .put('/:id', valid('param', idParam), validJson(channelUpdateInput), async (c) => {
    const change = c.req.valid('json')
    if (fromEa() && change.sender !== undefined) {
      return refuseEa(c, SENDER_RULES)
    }
    return ok(c, await updateChannel(c.req.valid('param').id, change))
  })
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
  .put('/:id/threads', notEa(THREAD_SWITCHES), valid('param', idParam), validJson(webhookThreadsInput), async (c) =>
    ok(c, await setWebhookThreads(c.req.valid('param').id, c.req.valid('json'))),
  )
  .put('/:id/filter', valid('param', idParam), validJson(webhookFilterInput), async (c) =>
    ok(c, await setWebhookFilter(c.req.valid('param').id, c.req.valid('json'))),
  )
  .post('/:id/filter/test', valid('param', idParam), validJson(webhookFilterTestInput), async (c) =>
    ok(c, await testFilter(c.req.valid('param').id, c.req.valid('json'))),
  )
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
  .put(
    '/:id/subscriptions/:sub/delivery',
    valid('param', subscriptionParam),
    validJson(subscriptionDeliveryInput),
    async (c) => {
      const { id, sub } = c.req.valid('param')
      return ok(c, await setChannelDelivery(id, sub, c.req.valid('json').delivery))
    },
  )
  .delete('/:id/subscriptions/:sub', valid('param', subscriptionParam), async (c) => {
    const { id, sub } = c.req.valid('param')
    return ok(c, await unsubscribeChannel(id, sub))
  })

/** Mounted beside taskRoutes under /api/tasks: a task's channels and the threads it posted in. */
export const taskChannelRoutes = new Hono()
  .get('/:id/channels', async (c) => ok(c, await subscriptions.forTask(c.req.param('id'))))
  .get('/:id/threads', async (c) => ok(c, await threadFollows.forTask((await requireTask(c.req.param('id'))).id)))
  .post('/:id/threads/:follow/stop', valid('param', threadParam), async (c) => {
    const { id, follow } = c.req.valid('param')
    return ok(c, await stopFollowing(id, follow))
  })

/** Mounted under /api/ea: the channels whose events reach the EA's inbox. */
export const eaChannelRoutes = new Hono().get('/channels', async (c) => ok(c, await subscriptions.forEa()))
