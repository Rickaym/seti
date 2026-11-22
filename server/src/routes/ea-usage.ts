import { eaThoughtInput, eaUsageInput, homeQuery, thoughtSummary, type EaUsageRecorded } from '@seti/shared'
import { Hono } from 'hono'
import { audit } from '../audit.js'
import { now } from '../db.js'
import { readerZone } from '../home.js'
import { ok, valid, validJson } from '../http.js'
import { eaUsage } from '../store/ea-usage.js'
import { botOnly } from './ea-state.js'

/**
 * The EA's token use and latency: the bot reports them, the settings page and tools read them.
 * Each think it ran is audited in numbers only.
 */
export const eaUsageRoutes = new Hono()
  .get('/usage', valid('query', homeQuery), async (c) =>
    ok(c, await eaUsage.stats(await readerZone(c.req.valid('query')), now())),
  )
  .post('/usage', botOnly, validJson(eaUsageInput), async (c) =>
    ok(c, { recorded: await eaUsage.add(c.req.valid('json').records, now()) } satisfies EaUsageRecorded),
  )
  .post('/thoughts', botOnly, validJson(eaThoughtInput), async (c) => {
    const input = c.req.valid('json')
    await audit.record({
      actor: 'user',
      kind: 'ea.thought',
      subject_type: 'ea',
      summary: thoughtSummary(input),
      detail: input,
    })
    return ok(c, { recorded: true })
  })
