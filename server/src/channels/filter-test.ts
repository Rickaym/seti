import {
  normalizeEventKind,
  type webhookFilterTestInput,
  type WebhookFilterTestResult,
  type WebhookFilterTestRow,
} from '@seti/shared'
import type { z } from 'zod'
import { HttpError } from '../http.js'
import { redactCredentials } from '../scrub.js'
import { channelStore, type ChannelRecord } from '../store/channels.js'
import type { FilterEventInput } from './filter-protocol.js'
import { filterInput, runFilter, type FilterPool, type FilterVerdict } from './filter-run.js'
import { clip } from './publish.js'
import { channelSource } from './sender-info.js'
import { pastedHeaders } from './sender-sample.js'

const TITLE_MAX = 200

type Source = WebhookFilterTestRow['source']

function row(source: Source, receivedAt: string | null, input: FilterEventInput, verdict: FilterVerdict) {
  return {
    source,
    received_at: receivedAt,
    event: input.event,
    title: clip(redactCredentials(input.title), TITLE_MAX),
    outcome: verdict.outcome,
    changed: verdict.outcome === 'changed' ? verdict.change : null,
    error: verdict.outcome === 'failed' ? verdict.error : null,
    logs: verdict.logs,
  } satisfies WebhookFilterTestRow
}

const isInput = (value: unknown): value is FilterEventInput =>
  typeof value === 'object' && value !== null && 'event' in value && 'title' in value && 'payload' in value

/** The filter's input a stored delivery kept, or null when it no longer reads as one. */
function storedInput(sample: string): FilterEventInput | null {
  try {
    const value: unknown = JSON.parse(sample)
    return isInput(value) ? value : null
  } catch {
    return null
  }
}

/** A pasted request read the way the webhook's sender reads a delivery, without its signature. */
async function pastedInput(
  record: ChannelRecord,
  sample: { headers: string; body: string },
): Promise<FilterEventInput | string> {
  const adapter = channelSource(record)?.adapter
  if (adapter === undefined) {
    return 'No sender reads this webhook now'
  }
  const headers = pastedHeaders(sample.headers)
  const decoded = adapter.decode({ headers, body: Buffer.from(sample.body, 'utf8') })
  if (!decoded.ok) {
    return `The sample is refused: ${decoded.reason}`
  }
  const parsed = await adapter.parse(decoded.payload, headers, { channelName: record.name, mapping: record.mapping })
  if (parsed.kind !== 'event') {
    return `The sender makes no event of the sample: ${parsed.reason}`
  }
  const kind = normalizeEventKind(redactCredentials(parsed.fields.kind ?? ''))
  return filterInput({ ...parsed.fields, kind }, headers, decoded.payload)
}

/**
 * Runs filter code against the webhook's recent deliveries and a pasted request, one at a time
 * so a slow filter never takes every worker from live deliveries. It stores and sends nothing.
 */
export async function testFilter(
  id: string,
  input: z.output<typeof webhookFilterTestInput>,
  workers?: FilterPool,
): Promise<WebhookFilterTestResult> {
  const record = await channelStore.get(id)
  if (record === undefined) {
    throw new HttpError(404, 'No such webhook')
  }
  const rows: WebhookFilterTestRow[] = []
  let sampleError: string | null = null
  if (input.sample !== undefined) {
    const pasted = await pastedInput(record, input.sample)
    if (typeof pasted === 'string') {
      sampleError = pasted
    } else {
      rows.push(row('sample', null, pasted, await runFilter(input.script, pasted, workers)))
    }
  }
  for (const stored of await channelStore.samples(id)) {
    const replay = storedInput(stored.sample)
    if (replay !== null) {
      rows.push(row('delivery', stored.received_at, replay, await runFilter(input.script, replay, workers)))
    }
  }
  return { rows, sample_error: sampleError }
}
