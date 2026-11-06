import {
  eaHistoryAppendInput,
  eaHistoryQuery,
  eaSettingsInput,
  eaSummaryInput,
  type EaHistoryAppended,
  type EaHistoryCleared,
  type EaSettings,
} from '@seti/shared'
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { currentRequestSource } from '../access.js'
import { audit } from '../audit.js'
import { fail, HttpError, ok, valid, validJson } from '../http.js'
import { eaHistory, eaSettings } from '../store/ea.js'

const BODY_MAX = 1024 * 1024

/** The change a person cares about: the form of address when it moved, else the wake word. */
function settingsSummary(before: EaSettings, saved: EaSettings): string {
  if (saved.form_of_address !== before.form_of_address) {
    return saved.form_of_address === ''
      ? 'EA addresses the user with no title'
      : `EA addresses the user as "${saved.form_of_address}"`
  }
  const wake = saved.wake_enabled ? `on, "${saved.wake_phrase}"` : 'off'
  return `EA wake word ${wake}`
}

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
  .get('/settings', async (c) => ok(c, await eaSettings.get()))
  .put('/settings', validJson(eaSettingsInput), async (c) => {
    const before = await eaSettings.get()
    const input = c.req.valid('json')
    const saved = await eaSettings.save({ ...input, form_of_address: input.form_of_address ?? before.form_of_address })
    await audit.record({
      actor: 'user',
      kind: 'ea.settings_changed',
      subject_type: 'ea',
      summary: settingsSummary(before, saved),
      detail: {
        wake_enabled: saved.wake_enabled,
        wake_phrase: saved.wake_phrase,
        keep_awake_seconds: saved.keep_awake_seconds,
        join_on_open: saved.join_on_open,
        form_of_address: saved.form_of_address,
        was_enabled: before.wake_enabled,
        was_form_of_address: before.form_of_address,
      },
    })
    return ok(c, saved)
  })
