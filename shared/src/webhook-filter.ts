import { z } from 'zod'

/** The limits of a webhook filter, in one place: the engine, the waits and what it may return. */
export const WEBHOOK_FILTER_LIMITS = {
  memoryMb: 32,
  /** Compute a run may use, and the time from its start to its answer. */
  computeMs: 1000,
  timeoutMs: 1000,
  /** How long a delivery waits for a free filter worker before the filter counts as failed. */
  waitMs: 2000,
  /** Filter worker threads; each runs one filter at a time. */
  workers: 2,
  scriptMaxChars: 10_000,
  headerValueChars: 200,
  outputMaxBytes: 16 * 1024,
  logLines: 20,
  logLineChars: 300,
  /** How many consecutive failures put a warning on the webhook's card. */
  failuresBeforeWarning: 3,
  /** How many recent deliveries keep what a test run needs. */
  samplesKept: 20,
  sampleMaxChars: 256 * 1024,
} as const

/** The longest text a filter may put in each field it changes; longer text is clipped. */
export const WEBHOOK_FILTER_FIELDS = { event: 80, title: 200, link: 2000, detail: 2000 } as const
export type WebhookFilterField = keyof typeof WEBHOOK_FILTER_FIELDS

/**
 * The request headers a filter sees: names that say which event a delivery is. Signatures,
 * tokens and every other header stay out.
 */
export const WEBHOOK_FILTER_HEADERS = [
  'content-type',
  'user-agent',
  'linear-delivery',
  'linear-event',
  'sentry-hook-resource',
  'webhook-id',
  'x-atlassian-webhook-identifier',
  'x-event-key',
  'x-github-delivery',
  'x-github-event',
  'x-github-hook-installation-target-type',
  'x-gitlab-event',
  'x-request-uuid',
  'x-shopify-topic',
  'x-shopify-webhook-id',
] as const

/** A header name that never reaches a filter, even if a later allowlist names it. */
export const WEBHOOK_FILTER_HEADER_REFUSED = /auth|sign|token|secret|cookie|password|api[-_]?key|hmac/i

/** What a filter did with one delivery: kept it, kept it changed, dropped it, or failed. */
export const WEBHOOK_FILTER_OUTCOMES = ['kept', 'changed', 'dropped', 'failed'] as const
export type WebhookFilterOutcome = (typeof WEBHOOK_FILTER_OUTCOMES)[number]

/** The code a new filter starts from: it keeps every delivery until edited. */
export const WEBHOOK_FILTER_TEMPLATE = `export default function filter(event) {
  // Return false to drop the delivery, true to keep it, or { title: '...' } to change it.
  return true
}
`

export const WEBHOOK_FILTER_API_DOC = [
  'export default function filter(event, { log }) { ... }',
  'May be async. event is { event, action, title, link, detail, headers, payload }:',
  '  event   the event name subscriptions filter on, such as issue.create or check_run.completed',
  '  action  the part after the first dot, such as create, or null',
  '  title, link, detail  what the sender produced; link may be null',
  '  headers  a few headers that name the event, such as x-github-event; never signatures or tokens',
  '  payload  the parsed JSON body, at most 256 KB like every webhook body',
  '',
  'Return null or false to drop the delivery, true to keep it unchanged, or an object to keep it',
  'with any of event, title, link and detail replaced by strings (link an http or https URL).',
  'Anything else is an error. log(...values) keeps a line that Test shows.',
  '',
  `A filter runs in an isolated engine with no network, files, timers or Node, in ${String(WEBHOOK_FILTER_LIMITS.memoryMb)} MB`,
  `and ${String(WEBHOOK_FILTER_LIMITS.timeoutMs / 1000)} s.`,
  'When it throws, times out or returns anything else, the delivery goes through unchanged',
  'and the delivery log says why.',
].join('\n')

/** Saves a webhook's filter; empty code removes it. */
export const webhookFilterInput = z
  .object({
    script: z.string().max(WEBHOOK_FILTER_LIMITS.scriptMaxChars),
    enabled: z.boolean(),
  })
  .refine((input) => input.script.trim() !== '' || !input.enabled, 'Write the filter function before turning it on')
export type WebhookFilterInput = z.input<typeof webhookFilterInput>

/** Runs filter code against the webhook's recent deliveries and, optionally, a pasted request. */
export const webhookFilterTestInput = z.object({
  script: z
    .string()
    .max(WEBHOOK_FILTER_LIMITS.scriptMaxChars)
    .refine((script) => script.trim() !== '', 'Write the filter function'),
  /** A request body as the sender sends it, with its headers one `Name: value` a line. */
  sample: z
    .object({ headers: z.string().max(16_384).default(''), body: z.string().max(WEBHOOK_FILTER_LIMITS.sampleMaxChars) })
    .optional(),
})
export type WebhookFilterTestInput = z.input<typeof webhookFilterTestInput>

/** A webhook's filter as the card and the tools show it, code in full. */
export interface WebhookFilterInfo {
  script: string
  enabled: boolean
  /** Failures in a row; the card warns from failuresBeforeWarning. */
  failures: number
  last_error: string | null
  last_error_at: string | null
  updated_at: string
  /** What the filter did over the last 24 hours. */
  day: Record<WebhookFilterOutcome, number>
}

/** What a filter did with one logged delivery; event and title are what the sender produced. */
export interface DeliveryFilter {
  outcome: WebhookFilterOutcome
  event: string
  title: string
  error: string | null
}

/** The fields a filter replaced; the rest stay as the sender produced them. */
export type WebhookFilterChange = Partial<Record<WebhookFilterField, string>>

/** One delivery a test ran the filter against: a recent one from the log, or the pasted sample. */
export interface WebhookFilterTestRow {
  source: 'delivery' | 'sample'
  received_at: string | null
  event: string
  title: string
  outcome: WebhookFilterOutcome
  changed: WebhookFilterChange | null
  error: string | null
  logs: string[]
}

export interface WebhookFilterTestResult {
  rows: WebhookFilterTestRow[]
  /** Why the pasted sample did not run, such as a body that is not JSON. */
  sample_error: string | null
}
