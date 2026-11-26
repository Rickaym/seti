import {
  callEndSummary,
  callQualityDetail,
  eaCallEndInput,
  eaHistoryAppendInput,
  eaHistoryQuery,
  eaSettingsInput,
  eaSummaryInput,
  type EaHistoryAppended,
  type EaHistoryCleared,
} from '@seti/shared'
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { currentRequestSource } from '../access.js'
import { audit } from '../audit.js'
import { fromDelegate } from '../ea-guard.js'
import { saveEaSettings } from '../ea-settings.js'
import { fail, HttpError, ok, valid, validJson } from '../http.js'
import { eaHistory, eaSettings } from '../store/ea.js'

const BODY_MAX = 1024 * 1024

/** Only the voice bot writes the conversation: loopback calls that carry its marker header. */
export const botOnly: MiddlewareHandler = async (c, next) => {
  if (currentRequestSource()?.via !== 'ea') {
    return fail(c, 403, 'Forbidden', 'Only the EA bot on this machine writes its conversation')
  }
  await next()
  return undefined
}

const limit = bodyLimit({
  maxSize: BODY_MAX,
  onError: (c) => fail(c, 413, 'Request too large', 'The EA history request body is too large'),
})

/** The EA's persistent conversation and its settings, both stored in Seti. */
export const eaStateRoutes = new Hono()
  .get('/history', valid('query', eaHistoryQuery), async (c) => {
    const query = c.req.valid('query')
    return ok(
      c,
      query.scope === 'context' ? await eaHistory.context() : await eaHistory.page(query.limit, query.before),
    )
  })
  .post('/history/messages', botOnly, limit, validJson(eaHistoryAppendInput), async (c) =>
    ok(c, { ids: await eaHistory.append(c.req.valid('json')) } satisfies EaHistoryAppended),
  )
  .put('/history/summary', botOnly, limit, validJson(eaSummaryInput), async (c) => {
    const { summary, through_id } = c.req.valid('json')
    const entry = await eaHistory.summarize(summary, through_id)
    if (entry === null) {
      throw new HttpError(409, 'The EA history changed; nothing to summarise up to that entry')
    }
    return ok(c, entry)
  })
  .delete('/history', async (c) => {
    const cleared = await eaHistory.clear()
    await audit.record({
      actor: 'user',
      kind: 'ea.history_cleared',
      subject_type: 'ea',
      summary: 'Started a new EA conversation',
      detail: { entries: cleared },
    })
    return ok(c, { cleared } satisfies EaHistoryCleared)
  })
  .put('/call-end', limit, validJson(eaCallEndInput), async (c) => {
    if (fromDelegate()) {
      throw new HttpError(403, 'Only the browser on the call reports how it ended')
    }
    const { quality, ...input } = c.req.valid('json')
    await audit.record({
      actor: 'user',
      kind: 'ea.call_ended',
      subject_type: 'ea',
      summary: callEndSummary(input),
      detail: { ...input, ...callQualityDetail(quality) },
    })
    return ok(c, { recorded: true })
  })
  .get('/settings', async (c) => ok(c, await eaSettings.get()))
  .put('/settings', validJson(eaSettingsInput), async (c) => ok(c, await saveEaSettings(c.req.valid('json'))))
