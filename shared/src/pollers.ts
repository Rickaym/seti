import { z } from 'zod'
import type { ChannelHealth } from './channel-health.js'
import { pollerTemplateId } from './channel-sources.js'
import { domainEntry } from './sandbox.js'

/** Limits every poller runs under; the README and the editor's help quote them. */
export const POLLER_LIMITS = {
  intervalMinS: 60,
  intervalDefaultS: 300,
  intervalMaxS: 86_400,
  timeoutMinS: 5,
  timeoutDefaultS: 30,
  timeoutMaxS: 120,
  memoryMb: 48,
  /** Longest stretch the script may compute without awaiting, and its total compute time. */
  cpuSliceMs: 1000,
  cpuTotalMs: 10_000,
  fetchesPerRun: 20,
  /** Sized so a run's responses, even as two-byte strings, fit the engine's memory. */
  responseMaxBytes: 4 * 1024 * 1024,
  runResponseMaxBytes: 12 * 1024 * 1024,
  requestBodyMaxBytes: 256 * 1024,
  maxItems: 500,
  outputMaxBytes: 1024 * 1024,
  stateMaxBytes: 16 * 1024,
  logLines: 50,
  logLineChars: 500,
  scriptMaxChars: 50_000,
  keysKept: 10_000,
  keysKeptDays: 30,
  failuresBeforeFailing: 5,
  concurrentRuns: 3,
  runsKept: 50,
} as const

/** A poller's own event kinds; an item with kind K reports K, K.changed and K.gone instead. */
export const POLLER_EVENT_KINDS = ['new', 'changed', 'gone', 'poller_failed', 'poller_recovered'] as const

/** The script API, as the editor shows it next to the code. */
export const POLLER_API_DOC = [
  'export default async function poll({ fetch, parseFeed, log, state, since })',
  'Return an array of items, or { items, state } to keep a small JSON state for the next run.',
  '',
  'Item: key (required, stable id), title, kind, url, body or summary, fields (object), fingerprint.',
  'A new key reports kind or "new"; a changed fingerprint reports kind.changed or "changed";',
  'with gone detection on, a missing key reports kind.gone or "gone". The first run only records.',
  '',
  'fetch(url, { method, headers, body, secretHeaders, secretQuery }) returns',
  '{ status, ok, url, headers.get(name), text(), json() }. Only hosts on the sandbox allowlist and',
  "this poller's extra hosts, never private addresses. secretHeaders and secretQuery take",
  "templates such as 'Bearer {{my_token}}'; Seti fills in secrets this poller may use, and the",
  'script never sees their values.',
  'parseFeed(text) reads RSS or Atom into [{ id, title, link, summary, published, updated }].',
  'log(...values) keeps a line for the run log. since is the last successful run, or null.',
  '',
  'Pollers run JavaScript in an isolated engine: no Node, files, processes, timers or CLIs.',
].join('\n')

const SECRET_REF = /^[a-z][a-z0-9_]{1,62}(:[a-z0-9-]{1,39})?$/

/** A secret a poller may use: github_agent_token, github_agent_token:owner, or a named secret. */
export const pollerSecretRef = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SECRET_REF, 'Use a secret name such as my_token or github_agent_token:octo-org')
  .refine((name) => name !== 'claude_oauth_token', 'Pollers cannot use the Claude token')

const fieldName = z.string().trim().min(1).max(80)

const unique = <T>(items: T[]) => [...new Set(items)]

const pollerFields = {
  script: z
    .string()
    .max(POLLER_LIMITS.scriptMaxChars)
    .refine((script) => script.trim() !== '', 'Write the poll function'),
  preset: pollerTemplateId,
  interval_s: z.number().int().min(POLLER_LIMITS.intervalMinS).max(POLLER_LIMITS.intervalMaxS),
  timeout_s: z.number().int().min(POLLER_LIMITS.timeoutMinS).max(POLLER_LIMITS.timeoutMaxS),
  extra_hosts: z.array(domainEntry).max(20).transform(unique),
  secrets: z.array(pollerSecretRef).max(10).transform(unique),
  fingerprint_fields: z.array(fieldName).max(20).transform(unique),
  detect_gone: z.boolean(),
  enabled: z.boolean(),
}

/** What runs a poller and how it reports: everything but its name and subscribers. */
export const pollerSettingsInput = z.object({
  script: pollerFields.script,
  preset: pollerFields.preset.default('blank'),
  interval_s: pollerFields.interval_s.default(POLLER_LIMITS.intervalDefaultS),
  timeout_s: pollerFields.timeout_s.default(POLLER_LIMITS.timeoutDefaultS),
  extra_hosts: pollerFields.extra_hosts.default([]),
  secrets: pollerFields.secrets.default([]),
  fingerprint_fields: pollerFields.fingerprint_fields.default([]),
  detect_gone: pollerFields.detect_gone.default(false),
  enabled: pollerFields.enabled.default(true),
})
export type PollerSettings = z.output<typeof pollerSettingsInput>

/** Settings only the user changes: what a poller may reach and which secrets it may use. */
export const POLLER_SECURITY_FIELDS = ['extra_hosts', 'secrets'] as const

export const pollerCreateInput = pollerSettingsInput.extend({
  name: z.string().trim().min(1).max(80),
  subscribe_ea: z.boolean().default(false),
})
export type PollerCreateInput = z.input<typeof pollerCreateInput>

export const pollerUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    script: pollerFields.script.optional(),
    preset: pollerFields.preset.optional(),
    interval_s: pollerFields.interval_s.optional(),
    timeout_s: pollerFields.timeout_s.optional(),
    extra_hosts: pollerFields.extra_hosts.optional(),
    secrets: pollerFields.secrets.optional(),
    fingerprint_fields: pollerFields.fingerprint_fields.optional(),
    detect_gone: pollerFields.detect_gone.optional(),
    enabled: pollerFields.enabled.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), 'Change at least one field')
export type PollerUpdateInput = z.input<typeof pollerUpdateInput>
export type PollerChange = z.output<typeof pollerUpdateInput>

/** A test run takes the settings as edited, saved or not; a saved poller's id reuses its state. */
export const pollerTestInput = pollerSettingsInput.extend({ channel_id: z.string().max(100).optional() })
export type PollerTestInput = z.input<typeof pollerTestInput>

/** An item as Seti read it from a run, after its checks. */
export interface PollerItem {
  key: string
  title: string
  kind: string
  url: string | null
  body: string
  fields: Record<string, unknown>
  fingerprint: string
}

export type PollerRunTrigger = 'schedule' | 'manual'

export interface PollerRun {
  id: number
  channel_id: string
  trigger: PollerRunTrigger
  /** When the schedule wanted the run; null for a run on request and runs from before Seti kept it. */
  due_at: string | null
  started_at: string
  duration_ms: number
  ok: boolean
  items: number
  emitted: number
  /** Items the script returned that Seti could not use, with why. */
  invalid: string[]
  error: string | null
  logs: string[]
}

/** ok: the last run worked; failing: it failed often enough to tell subscribers. */
export type PollerStatus = 'pending' | 'ok' | 'erroring' | 'failing' | 'paused'

export interface PollerInfo extends PollerSettings {
  status: PollerStatus
  failures: number
  last_run_at: string | null
  next_run_at: string | null
  /** When the first successful run recorded the items already there; null until then. */
  baseline_at: string | null
  keys: number
  runs: PollerRun[]
  health: ChannelHealth
}

export interface PollerTestResult {
  ok: boolean
  error: string | null
  items: PollerItem[]
  invalid: string[]
  logs: string[]
  duration_ms: number
  state: unknown
}
