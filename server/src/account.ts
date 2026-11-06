import os from 'node:os'
import { query, type AccountInfo, type SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk'
import {
  NO_LOGINS,
  type AccountHealth,
  type AccountIdentity,
  type AccountStatus,
  type ClaudeLogins,
  type PlanUsage,
  type RateLimitObservation,
  type TaskLoginError,
  type UsageWindow,
} from '@seti/shared'
import { z } from 'zod'
import { mergeWindows, parseRateLimitEvent, parseUsage, type UsageReading } from './account-usage.js'
import { audit } from './audit.js'
import { idlePrompt, probeEnv, withTimeout } from './capabilities.js'
import { hostLoginKey, loginsView } from './claude-logins.js'
import { cache } from './redis.js'
import { accountSignals, type StoredTaskMessage } from './store/account.js'
import { auditEvents } from './store/audit.js'

/** The slice of an SDK Query the account check uses, so tests can inject a fake. */
export interface AccountSession {
  initializationResult: () => Promise<SDKControlInitializeResponse>
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts: { skipBehaviors: boolean }) => Promise<unknown>
  close: () => void
}

export type StartAccountSession = (signal: AbortSignal) => AccountSession

export interface AccountTiming {
  initTimeoutMs: number
  usageTimeoutMs: number
}

const DEFAULT_TIMING: AccountTiming = { initTimeoutMs: 30_000, usageTimeoutMs: 15_000 }

export interface AccountProbe {
  fetched_at: string
  account: AccountIdentity | null
  usage: UsageReading
  error: string | null
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

const toIdentity = (account: AccountInfo): AccountIdentity => ({
  email: account.email ?? null,
  organization: account.organization ?? null,
  subscription_type: account.subscriptionType ?? null,
  token_source: account.tokenSource ?? null,
  api_key_source: account.apiKeySource ?? null,
  api_provider: account.apiProvider ?? null,
})

async function readUsage(session: AccountSession, timing: AccountTiming): Promise<UsageReading> {
  try {
    const usage = session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
    return parseUsage(await withTimeout(usage, timing.usageTimeoutMs, 'plan usage'))
  } catch (e) {
    return { ok: false, reason: `Plan usage is unavailable: ${messageOf(e)}` }
  }
}

/** Opens a session whose prompt never yields, so no message is sent, and reads login and usage. */
export async function probeAccount(start: StartAccountSession, timing: AccountTiming): Promise<AccountProbe> {
  const abort = new AbortController()
  let session: AccountSession | undefined
  try {
    session = start(abort.signal)
    const init = await withTimeout(session.initializationResult(), timing.initTimeoutMs, 'Claude Code to start')
    const usage = await readUsage(session, timing)
    return { fetched_at: new Date().toISOString(), account: toIdentity(init.account), usage, error: null }
  } catch (e) {
    const usage = { ok: false, reason: 'Claude Code did not start' } as const
    return { fetched_at: new Date().toISOString(), account: null, usage, error: messageOf(e) }
  } finally {
    abort.abort()
    session?.close()
  }
}

const startSdkSession: StartAccountSession = (signal) =>
  query({
    prompt: idlePrompt(signal),
    options: { cwd: os.homedir(), settingSources: ['user', 'project', 'local'], env: probeEnv() },
  })

const SHARED_KEY = 'account:probe'
const SHARED_TTL_S = 60 * 60

interface SharedProbe {
  probe: AccountProbe
  verified_at: string | null
  /** The login Claude Code used when the probe ran, so a switch since then probes again. */
  login?: string | null
}

/**
 * Caches the latest probe, shares one in-flight probe, and shares results through Redis. A probe
 * of a login Claude Code no longer uses, after a switch or a terminal /login, does not count.
 */
export function createAccountMonitor(
  start: StartAccountSession = startSdkSession,
  timing = DEFAULT_TIMING,
  loginKey: () => string | null = hostLoginKey,
) {
  let latest: AccountProbe | undefined
  let latestLogin: string | null = null
  let verifiedAt: string | null = null
  let inflight: Promise<AccountProbe> | undefined

  const refresh = async (): Promise<AccountProbe> => {
    const login = loginKey()
    inflight ??= probeAccount(start, timing)
      .then(async (probe) => {
        latest = probe
        latestLogin = login
        if (probe.usage.ok) {
          verifiedAt = probe.fetched_at
        }
        const shared: SharedProbe = { probe, verified_at: verifiedAt, login }
        await cache.set(SHARED_KEY, shared, SHARED_TTL_S)
        return probe
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  /** Takes a probe another process or an earlier run made within `maxAgeMs`; false if none. */
  const warm = async (maxAgeMs: number, now = Date.now()): Promise<boolean> => {
    const shared = await cache.get<SharedProbe>(SHARED_KEY)
    const login = loginKey()
    if (shared === undefined || now - Date.parse(shared.probe.fetched_at) >= maxAgeMs) {
      return false
    }
    if ((shared.login ?? login) !== login) {
      return false
    }
    latest = shared.probe
    latestLogin = login
    verifiedAt = shared.verified_at
    return true
  }

  return {
    /** When a probe last proved the login works by reading its plan usage. */
    verifiedAt: () => verifiedAt,
    get: async () => (latest !== undefined && latestLogin === loginKey() ? latest : refresh()),
    refresh,
    warm,
  }
}

const accountMonitor = createAccountMonitor()

const API_KEY_SOURCES = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', 'user', 'project', 'org', 'temporary'])
const API_TOKEN_SOURCES = new Set(['ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper'])
const INSTEAD = 'instead of your Claude Code login'

function apiKeyMessage(account: AccountIdentity): string | null {
  if (account.api_provider !== null && account.api_provider !== 'firstParty') {
    return `Agents use ${account.api_provider} credentials ${INSTEAD}.`
  }
  if (account.api_key_source !== null && API_KEY_SOURCES.has(account.api_key_source)) {
    return `Agents use an API key from ${account.api_key_source} ${INSTEAD}.`
  }
  if (account.token_source !== null && API_TOKEN_SOURCES.has(account.token_source)) {
    return `Agents use a token from ${account.token_source} ${INSTEAD}.`
  }
  return null
}

const isUnset = (value: string | null) => value === null || value === 'none'

const isLoggedOut = (account: AccountIdentity) =>
  account.email === null && isUnset(account.token_source) && isUnset(account.api_key_source)

function loginName(account: AccountIdentity): string {
  const who = account.email ?? account.token_source ?? account.api_key_source ?? 'an unknown account'
  return account.subscription_type === null ? who : `${who} (${account.subscription_type})`
}

/** A task login failure counts until a later success or usage read (clearedAt) supersedes it. */
export function deriveHealth(
  probe: AccountProbe,
  taskError: TaskLoginError | null,
  clearedAt: string | null,
): AccountHealth {
  const { account } = probe
  if (account === null) {
    return { state: 'error', message: `Could not read the Claude Code login: ${probe.error ?? 'unknown error'}` }
  }
  const apiKey = apiKeyMessage(account)
  if (apiKey !== null) {
    return { state: 'api_key', message: apiKey }
  }
  if (isLoggedOut(account)) {
    return { state: 'logged_out', message: 'Claude Code is not logged in on this machine.' }
  }
  if (taskError !== null && (clearedAt === null || taskError.at > clearedAt)) {
    return { state: 'error', message: `A turn in "${taskError.task_title}" failed with ${taskError.error}.` }
  }
  return { state: 'ok', message: `Using the Claude Code login of ${loginName(account)}.` }
}

const MAX_ERROR_TEXT = 300

const failureSchema = z.union([
  z.object({
    type: z.literal('assistant'),
    error: z.string(),
    message: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).optional(),
  }),
  z.object({ type: z.literal('result'), api_error_status: z.number(), result: z.string().optional() }),
])

export function toTaskLoginError(row: StoredTaskMessage): TaskLoginError | null {
  const parsed = failureSchema.safeParse(JSON.parse(row.payload))
  if (!parsed.success) {
    return null
  }
  const m = parsed.data
  const text =
    m.type === 'assistant'
      ? (m.message?.content ?? []).flatMap((block) => (block.text === undefined ? [] : [block.text])).join(' ')
      : (m.result ?? '')
  return {
    task_id: row.task_id,
    task_title: row.task_title,
    at: row.created_at,
    error: m.type === 'assistant' ? m.error : `HTTP ${String(m.api_error_status)}`,
    message: text === '' ? null : text.slice(0, MAX_ERROR_TEXT),
  }
}

export function toRateLimitObservation(row: StoredTaskMessage): RateLimitObservation | null {
  const parsed = parseRateLimitEvent(JSON.parse(row.payload))
  return parsed && { task_id: row.task_id, task_title: row.task_title, at: row.created_at, ...parsed }
}

export interface TaskSignals {
  /** Newest first. */
  rateLimitEvents: RateLimitObservation[]
  loginFailure: TaskLoginError | null
  lastSuccessAt: string | null
}

const latestOf = (a: string | null, b: string | null) => (a === null || (b !== null && b > a) ? b : a)

const streamWindows = (events: readonly RateLimitObservation[]) =>
  events.reduceRight<UsageWindow[]>((merged, event) => mergeWindows(merged, event.windows), [])

/** Each window keeps its newest reading, from the usage API or a later agent rate limit event. */
function pickUsage(probe: AccountProbe, events: readonly RateLimitObservation[]): PlanUsage | null {
  const newer = probe.usage.ok ? events.filter((event) => event.at > probe.fetched_at) : events
  const stream = streamWindows(newer)
  const newest = newer.at(0)
  if (probe.usage.ok) {
    const api = { source: 'usage_api', observed_at: probe.fetched_at, windows: probe.usage.windows } as const
    return newest === undefined || stream.length === 0
      ? api
      : { source: 'mixed', observed_at: newest.at, windows: mergeWindows(api.windows, stream) }
  }
  if (newest === undefined || stream.length === 0) {
    return null
  }
  return { source: 'task_stream', observed_at: newest.at, windows: stream }
}

export function buildStatus(
  probe: AccountProbe,
  signals: TaskSignals,
  verifiedAt: string | null,
  logins: ClaudeLogins = NO_LOGINS,
): AccountStatus {
  return {
    account: probe.account,
    logins,
    health: deriveHealth(probe, signals.loginFailure, latestOf(signals.lastSuccessAt, verifiedAt)),
    usage: pickUsage(probe, signals.rateLimitEvents),
    usage_note: probe.usage.ok ? null : probe.usage.reason,
    rate_limit_event: signals.rateLimitEvents.at(0) ?? null,
    task_error: signals.loginFailure,
    fetched_at: probe.fetched_at,
  }
}

/** Enough recent events that a window an event left out still has a reading. */
const RATE_LIMIT_EVENTS_READ = 20

/** Agent signals from before the latest login switch belong to the previous login. */
async function readSignals(): Promise<TaskSignals> {
  const [events, failure, lastSuccessAt, switched] = await Promise.all([
    accountSignals.recentRateLimitEvents(RATE_LIMIT_EVENTS_READ),
    accountSignals.latestLoginFailure(),
    accountSignals.latestSuccessAt(),
    auditEvents.latest('account.switched'),
  ])
  const since = switched?.at ?? ''
  const loginFailure = failure ? toTaskLoginError(failure) : null
  return {
    rateLimitEvents: events.flatMap((event) => toRateLimitObservation(event) ?? []).filter((event) => event.at > since),
    loginFailure: loginFailure !== null && loginFailure.at > since ? loginFailure : null,
    lastSuccessAt,
  }
}

async function recordHealthChange(health: AccountHealth): Promise<void> {
  const previous = (await auditEvents.latest('account.health_changed'))?.detail.to ?? null
  if (previous === health.state) {
    return
  }
  const change = typeof previous === 'string' ? [previous, 'to', health.state] : [health.state]
  await audit.record({
    actor: 'system',
    kind: 'account.health_changed',
    subject_type: 'account',
    summary: `Login health ${change.join(' ')}`,
    detail: { from: previous, to: health.state, message: health.message },
  })
}

let healthChecks: Promise<void> = Promise.resolve()

/** Records a health state that differs from the last recorded one, across restarts too. */
export async function auditHealthChange(health: AccountHealth): Promise<void> {
  const next = healthChecks.then(async () => recordHealthChange(health))
  healthChecks = next.catch(() => undefined)
  return next
}

/** Adopts a recent probe from Redis instead of starting a new one, as after a restart. */
export const warmAccount = async (maxAgeMs: number) => accountMonitor.warm(maxAgeMs)

/** Probes the login again after a switch, so plan usage follows the login in use. */
export function loginsChanged(): void {
  accountMonitor.refresh().catch((e: unknown) => {
    process.stderr.write(`account: probing the new login failed: ${messageOf(e)}\n`)
  })
}

export async function accountStatus(options: { refresh: boolean }): Promise<AccountStatus> {
  const probe = await (options.refresh ? accountMonitor.refresh() : accountMonitor.get())
  const status = buildStatus(probe, await readSignals(), accountMonitor.verifiedAt(), await loginsView())
  await auditHealthChange(status.health)
  return status
}
