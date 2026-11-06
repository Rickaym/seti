import { eaUsageInput, homeQuery, type EaUsageRecorded } from '@seti/shared'
import { Hono } from 'hono'
import { now } from '../db.js'
import { readerZone } from '../home.js'
import { ok, valid, validJson } from '../http.js'
import { botOnly } from './ea-state.js'
import { eaUsage } from '../store/ea-usage.js'

/** The EA's token use and latency: the bot reports them, the settings page and tools read them. */
export const eaUsageRoutes = new Hono()
  .get('/usage', valid('query', homeQuery), async (c) =>
    ok(c, await eaUsage.stats(await readerZone(c.req.valid('query')), now())),
  )
  .post('/usage', botOnly, validJson(eaUsageInput), async (c) =>
    ok(c, { recorded: await eaUsage.add(c.req.valid('json').records, now()) } satisfies EaUsageRecorded),
  )
