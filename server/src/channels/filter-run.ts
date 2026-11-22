import {
  WEBHOOK_FILTER_FIELDS,
  WEBHOOK_FILTER_HEADER_REFUSED,
  WEBHOOK_FILTER_HEADERS,
  WEBHOOK_FILTER_LIMITS,
  type WebhookFilterChange,
  type WebhookFilterField,
} from '@seti/shared'
import { createWorkerPool, type WorkerPool } from '../quickjs/pool.js'
import { redactSecrets } from '../scrub.js'
import type { FilterEventInput, FilterReply, FilterRequest, FilterReturn } from './filter-protocol.js'
import { clip } from './publish.js'

export type FilterPool = Pick<WorkerPool<FilterRequest, FilterReply>, 'run'>

/** What a filter made of one delivery; a failure carries the reason, never the payload. */
export type FilterVerdict =
  | { outcome: 'kept' | 'dropped'; logs: string[] }
  | { outcome: 'changed'; change: WebhookFilterChange; logs: string[] }
  | { outcome: 'failed'; error: string; logs: string[] }

const MB = 1024 * 1024
/** How long past its timeout a run gets before its worker is stopped from outside. */
const WALL_GRACE_MS = 1000
const ERROR_MAX = 300

/** Worker threads that run filters and stay warm between runs; tests make small ones. */
export const createFilterPool = (size: number = WEBHOOK_FILTER_LIMITS.workers) =>
  createWorkerPool<FilterRequest, FilterReply>({
    name: 'filter',
    entry: new URL('./filter-worker-entry.ts', import.meta.url),
    size,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    startupMs: 30_000,
  })

/** Webhook filters run here, so a burst of deliveries starts no process. */
export const filterWorkers = createFilterPool()

const LIMITS: FilterRequest['limits'] = {
  timeoutMs: WEBHOOK_FILTER_LIMITS.timeoutMs,
  memoryBytes: WEBHOOK_FILTER_LIMITS.memoryMb * MB,
  cpuSliceMs: WEBHOOK_FILTER_LIMITS.computeMs,
  cpuTotalMs: WEBHOOK_FILTER_LIMITS.computeMs,
  logLines: WEBHOOK_FILTER_LIMITS.logLines,
  logLineChars: WEBHOOK_FILTER_LIMITS.logLineChars,
  outputBytes: WEBHOOK_FILTER_LIMITS.outputMaxBytes,
}

/** The allowlisted headers a filter sees, lowercased and clipped; never a signature or a token. */
export function filterHeaders(headers: Headers): Record<string, string> {
  const shown: Record<string, string> = {}
  for (const name of WEBHOOK_FILTER_HEADERS) {
    const value = headers.get(name)
    if (value !== null && !WEBHOOK_FILTER_HEADER_REFUSED.test(name)) {
      shown[name] = clip(value, WEBHOOK_FILTER_LIMITS.headerValueChars)
    }
  }
  return shown
}

/** The event a filter gets from what the sender produced; action is what follows the first dot. */
export function filterInput(
  fields: { kind: string; title: string; url: string | null; detail: string },
  headers: Headers,
  payload: unknown,
): FilterEventInput {
  const dot = fields.kind.indexOf('.')
  return {
    event: fields.kind,
    action: dot === -1 ? null : fields.kind.slice(dot + 1),
    title: fields.title,
    link: fields.url,
    detail: fields.detail,
    headers: filterHeaders(headers),
    payload,
  }
}

const isReturn = (value: unknown): value is FilterReturn =>
  typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string'

const INVALID = 'return null or false to drop, true to keep, or an object with event, title, link or detail'

/** Reads the object a filter returned as the fields it replaces, or why it is unusable. */
function readChange(value: object): { change: WebhookFilterChange } | { error: string } {
  const change: WebhookFilterChange = {}
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (!(key in WEBHOOK_FILTER_FIELDS)) {
      return { error: `The filter returned an unknown field ${clip(key, 40)}; ${INVALID}` }
    }
    const field = key as WebhookFilterField
    if (typeof text !== 'string' && !(field === 'link' && text === null)) {
      return { error: `The filter returned ${field} as ${text === null ? 'null' : typeof text}, not a string` }
    }
    if (field === 'link' && text !== null && !/^https?:\/\//i.test(text)) {
      return { error: 'The filter returned a link that is not an http or https URL' }
    }
    change[field] = clip(text ?? '', WEBHOOK_FILTER_FIELDS[field])
  }
  return { change }
}

/** What the returned value means: drop, keep, keep changed, or an error. */
function readVerdict(returned: unknown, logs: string[]): FilterVerdict {
  if (!isReturn(returned)) {
    return { outcome: 'failed', error: 'The filter engine returned nothing usable', logs }
  }
  const { kind, value } = returned
  if (kind === 'null' || value === false) {
    return { outcome: 'dropped', logs }
  }
  if (value === true) {
    return { outcome: 'kept', logs }
  }
  if (kind !== 'object' || typeof value !== 'object' || value === null) {
    return {
      outcome: 'failed',
      error: `The filter returned ${kind === 'undefined' ? 'nothing' : kind}; ${INVALID}`,
      logs,
    }
  }
  const read = readChange(value)
  if ('error' in read) {
    return { outcome: 'failed', error: read.error, logs }
  }
  return Object.keys(read.change).length === 0
    ? { outcome: 'kept', logs }
    : { outcome: 'changed', change: read.change, logs }
}

const failure = (error: string, logs: string[] = []): FilterVerdict => ({
  outcome: 'failed',
  error: clip(redactSecrets(error), ERROR_MAX),
  logs,
})

/** Runs a filter once on a warm worker; every failure, the worker's own included, is a verdict. */
export async function runFilter(
  script: string,
  input: FilterEventInput,
  workers: FilterPool = filterWorkers,
): Promise<FilterVerdict> {
  try {
    const reply = await workers.run(
      { script, input, limits: LIMITS },
      WEBHOOK_FILTER_LIMITS.timeoutMs + WALL_GRACE_MS,
      WEBHOOK_FILTER_LIMITS.waitMs,
    )
    return reply.ok ? readVerdict(reply.value, reply.logs) : failure(reply.error, reply.logs)
  } catch (e) {
    return failure(e instanceof Error ? e.message : String(e))
  }
}
