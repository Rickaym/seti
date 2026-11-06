import {
  eaAskConfirmInput,
  eaAskDecisionInput,
  eaAskInput,
  eaAskOutcomeInput,
  eaAskParams,
  eaRepliesSeenInput,
  type EaRepliesSeen,
} from '@seti/shared'
import { Hono } from 'hono'
import { audit } from '../audit.js'
import { now } from '../db.js'
import { decideAsk } from '../ea-asks.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { botOnly } from './ea-state.js'
import { eaAsks, eaReplies } from '../store/ea-replies.js'

/** EA messages the user has not seen, and the questions the EA asks before a tool acts. */
export const eaReplyRoutes = new Hono()
  .get('/replies', async (c) => ok(c, await eaReplies.unseen(now())))
  .post('/replies/seen', validJson(eaRepliesSeenInput), async (c) =>
    ok(c, { seen: await eaReplies.seen(c.req.valid('json'), now()) } satisfies EaRepliesSeen),
  )
  .post('/asks', botOnly, validJson(eaAskInput), async (c) => ok(c, await eaAsks.add(c.req.valid('json'), now())))
  .get('/asks/open', botOnly, async (c) => ok(c, await eaAsks.open(now())))
  .post('/asks/claim', botOnly, async (c) => ok(c, await eaAsks.claim(now())))
  .post('/asks/confirm', botOnly, validJson(eaAskConfirmInput), async (c) => {
    const asks = await eaAsks.confirm(c.req.valid('json'), now())
    for (const ask of asks) {
      await audit.record({
        actor: 'user',
        kind: 'ea.ask_allowed',
        subject_type: 'ea',
        summary: `Said yes to the EA to ${ask.summary}`,
        detail: { ask: ask.id, tool: ask.tool },
      })
    }
    return ok(c, asks)
  })
  .post('/asks/:id/outcome', botOnly, valid('param', eaAskParams), validJson(eaAskOutcomeInput), async (c) => {
    const ask = await eaAsks.outcome(c.req.valid('param').id, c.req.valid('json'), now())
    if (ask === undefined) {
      throw new HttpError(409, 'No allowed question waits for its outcome')
    }
    return ok(c, ask)
  })
  .post('/asks/:id/decision', valid('param', eaAskParams), validJson(eaAskDecisionInput), async (c) =>
    ok(c, await decideAsk(c.req.valid('param').id, c.req.valid('json').decision)),
  )
