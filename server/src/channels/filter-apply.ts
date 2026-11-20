import { normalizeEventKind, WEBHOOK_FILTER_LIMITS, type DeliveryFilter, type WebhookFilterChange } from '@seti/shared'
import { redactCredentials, scrubInput } from '../scrub.js'
import type { FilterEventInput } from './filter-protocol.js'
import { filterInput, runFilter, type FilterPool } from './filter-run.js'
import { clip } from './publish.js'
import type { EventFields } from './types.js'
import { webhookFilterStore } from '../store/webhook-filters.js'

const TITLE_MAX = 200
const REASON_MAX = 200

/** A verified delivery's event, after the webhook's filter, if any, had its say. */
export interface Filtered {
  fields: EventFields
  /** What the filter did, for the delivery log; null when no filter ran. */
  filter: DeliveryFilter | null
  /** Why the delivery stops here; null when it goes on to the subscribers. */
  dropped: string | null
  /** What a later filter test replays, as redacted JSON; null when it is too large to keep. */
  sample: string | null
}

export interface FilterSubject {
  channel: string
  fields: EventFields
  headers: Headers
  payload: unknown
}

/** The filter's input as a test may replay it: secrets redacted, null when it would not fit. */
function sampleOf(input: FilterEventInput): string | null {
  const text = JSON.stringify(scrubInput(input))
  return text.length > WEBHOOK_FILTER_LIMITS.sampleMaxChars ? null : text
}

function changed(fields: EventFields, change: WebhookFilterChange): EventFields {
  return {
    ...fields,
    ...(change.event === undefined ? {} : { kind: change.event }),
    ...(change.title === undefined ? {} : { title: change.title }),
    ...(change.link === undefined ? {} : { url: change.link === '' ? null : change.link }),
    ...(change.detail === undefined ? {} : { detail: change.detail }),
  }
}

/** Why a delivery stops at the filter, for the delivery log. */
function droppedReason(logged: DeliveryFilter): string {
  return clip(
    `filtered out ${logged.event === '' ? 'an event with no name' : logged.event}: ${logged.title}`,
    REASON_MAX,
  )
}

/**
 * Runs the channel's filter on a delivery's event, counts what it did and says whether the
 * delivery goes on. A filter that fails keeps the delivery unchanged.
 */
export async function applyFilter(subject: FilterSubject, at: string, workers?: FilterPool): Promise<Filtered> {
  const { fields } = subject
  const event = normalizeEventKind(redactCredentials(fields.kind ?? ''))
  const input = filterInput({ ...fields, kind: event }, subject.headers, subject.payload)
  const sample = sampleOf(input)
  const saved = await webhookFilterStore.get(subject.channel)
  if (saved?.enabled !== true) {
    return { fields, filter: null, dropped: null, sample }
  }
  const verdict = await runFilter(saved.script, input, workers)
  const error = verdict.outcome === 'failed' ? verdict.error : null
  await webhookFilterStore.record(subject.channel, verdict.outcome, error, at)
  const title = clip(redactCredentials(fields.title), TITLE_MAX)
  const filter: DeliveryFilter = { outcome: verdict.outcome, event, title, error }
  return {
    fields: verdict.outcome === 'changed' ? changed(fields, verdict.change) : fields,
    filter,
    dropped: verdict.outcome === 'dropped' ? droppedReason(filter) : null,
    sample,
  }
}
