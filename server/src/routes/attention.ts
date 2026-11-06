import { attentionBriefSeenInput, type AttentionState } from '@seti/shared'
import { Hono } from 'hono'
import { closeBrief, currentBrief } from '../attention-brief.js'
import { AWAY_AFTER_MS } from '../config.js'
import { eaTaskIds } from '../ea-attention.js'
import { ok, validJson } from '../http.js'

/** The brief waiting for the user and the agents the EA reports on, which every page reads. */
export const attentionRoutes = new Hono()
  .get('/', async (c) => {
    const [brief, eaTasks] = await Promise.all([currentBrief(), eaTaskIds()])
    return ok(c, { brief, ea_tasks: eaTasks, away_ms: AWAY_AFTER_MS } satisfies AttentionState)
  })
  .post('/brief/seen', validJson(attentionBriefSeenInput), async (c) =>
    ok(c, { closed: await closeBrief(c.req.valid('json').id) }),
  )
