import fs from 'node:fs'
import type { SDKControlInitializeResponse, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountIdentity, RateLimitObservation, TaskLoginError, UsageWindow } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mergeWindows, parseRateLimitEvent, parseUsage } from './account-usage.js'
import {
  buildStatus,
  createAccountMonitor,
  deriveHealth,
  probeAccount,
  toRateLimitObservation,
  toTaskLoginError,
  type AccountProbe,
  type AccountSession,
  type AccountTiming,
  type TaskSignals,
} from './account.js'
import { messages, tasks } from './db.js'
import { accountSignals } from './store/account.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-account-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  return root
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const FAST: AccountTiming = { initTimeoutMs: 100, usageTimeoutMs: 100 }

const LIVE_USAGE = {
  session: { total_cost_usd: 0 },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 22, resets_at: '2026-09-26T22:19:59.550163+00:00', locked_reason: null },
    seven_day: { utilization: 62, resets_at: '2026-09-26T22:59:59.550183+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    nimbus_quill: { utilization: 0, resets_at: null },
    extra_usage: { is_enabled: false, monthly_limit: 2000 },
    limits: [{ kind: 'session', percent: 22 }],
    model_scoped: [{ display_name: 'Fable', utilization: 7, resets_at: '2026-09-26T22:59:59.550358+00:00' }],
  },
  behaviors: null,
}

describe('parseUsage', () => {
  it('reads the plan windows and per-model windows, ignoring unknown keys', () => {
    expect(parseUsage(LIVE_USAGE)).toEqual({
      ok: true,
      windows: [
        { key: 'five_hour', label: '5-hour', utilization: 22, resets_at: '2026-09-26T22:19:59.550163+00:00' },
        { key: 'seven_day', label: 'Weekly', utilization: 62, resets_at: '2026-09-26T22:59:59.550183+00:00' },
        { key: 'model:Fable', label: 'Weekly Fable', utilization: 7, resets_at: '2026-09-26T22:59:59.550358+00:00' },
      ],
    })
  })

  it('keeps a window with a missing reset time and skips one with nothing in it', () => {
    const reading = parseUsage({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 5 }, seven_day: { utilization: null, resets_at: null } },
    })
    expect(reading).toEqual({
      ok: true,
      windows: [{ key: 'five_hour', label: '5-hour', utilization: 5, resets_at: null }],
    })
  })

  it('reports unavailable when plan limits do not apply', () => {
    expect(parseUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toEqual({
      ok: false,
      reason: 'Plan limits do not apply to this login',
    })
  })

  it('reports unavailable when no window has data', () => {
    expect(parseUsage({ rate_limits_available: true, rate_limits: { five_hour: null } })).toMatchObject({ ok: false })
  })

  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['null', null],
    ['an array', []],
    ['missing rate_limits_available', { rate_limits: { five_hour: { utilization: 1, resets_at: null } } }],
    ['missing rate_limits', { rate_limits_available: true }],
    ['a string window', { rate_limits_available: true, rate_limits: { five_hour: '22%' } }],
    ['a string utilization', { rate_limits_available: true, rate_limits: { seven_day: { utilization: '62' } } }],
    ['a malformed model window', { rate_limits_available: true, rate_limits: { model_scoped: [{ utilization: 1 }] } }],
    ['a renamed flag', { rateLimitsAvailable: true, rate_limits: null }],
  ])('treats %s as unavailable instead of throwing', (_name, raw) => {
    expect(parseUsage(raw)).toEqual({ ok: false, reason: 'The Claude Code usage API returned an unexpected shape' })
  })
})

const STREAM_EVENT = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1790461200,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    unifiedWindows: {
      five_hour: { utilization: 0.17, resetsAt: 1790461200 },
      seven_day: { utilization: 0.605, resetsAt: 1790463600 },
    },
  },
  uuid: 'u',
  session_id: 's',
}

describe('parseRateLimitEvent', () => {
  it('converts fractions to percentages and epoch seconds to ISO times', () => {
    expect(parseRateLimitEvent(STREAM_EVENT)).toEqual({
      status: 'allowed',
      rate_limit_type: 'five_hour',
      windows: [
        { key: 'five_hour', label: '5-hour', utilization: 17, resets_at: '2026-09-26T22:20:00.000Z' },
        { key: 'seven_day', label: 'Weekly', utilization: 60.5, resets_at: '2026-09-26T23:00:00.000Z' },
      ],
    })
  })

  it('falls back to the documented single window', () => {
    const event = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.81 },
    }
    expect(parseRateLimitEvent(event)?.windows).toEqual([
      { key: 'seven_day', label: 'Weekly', utilization: 81, resets_at: null },
    ])
  })

  it('returns null for other shapes', () => {
    expect(parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { resetsAt: 'soon' } })).toBeNull()
    expect(parseRateLimitEvent({ type: 'assistant' })).toBeNull()
  })
})

const identity = (overrides: Partial<AccountIdentity> = {}): AccountIdentity => ({
  email: 'me@example.com',
  organization: 'Org',
  subscription_type: 'Claude Max',
  token_source: null,
  api_key_source: null,
  api_provider: 'firstParty',
  ...overrides,
})

const probeWith = (account: AccountIdentity | null, error: string | null = null): AccountProbe => ({
  fetched_at: '2026-09-26T12:00:00.000Z',
  account,
  usage: { ok: false, reason: 'n/a' },
  error,
})

const TASK_ERROR: TaskLoginError = {
  task_id: 't1',
  task_title: 'Fix login',
  at: '2026-09-26T12:30:00.000Z',
  error: 'authentication_failed',
  message: 'Invalid API key',
}

const WEEKLY_WARNING = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: 1791068400,
    rateLimitType: 'seven_day',
    utilization: 0.76,
    isUsingOverage: false,
    surpassedThreshold: 0.75,
    unifiedWindows: {
      five_hour: { utilization: 0.28, resetsAt: 1790939400 },
      seven_day: { utilization: 0.76, resetsAt: 1791068400 },
    },
  },
}

const observation = (at: string, raw: unknown): RateLimitObservation => {
  const parsed = parseRateLimitEvent(raw)
  if (parsed === null) {
    throw new Error('fixture does not parse')
  }
  return { task_id: 't1', task_title: 'Nightly check', at, ...parsed }
}

const signals = (rateLimitEvents: RateLimitObservation[]): TaskSignals => ({
  rateLimitEvents,
  loginFailure: null,
  lastSuccessAt: null,
})

describe('plan usage per window', () => {
  const window = (key: string, utilization: number): UsageWindow => ({ key, label: key, utilization, resets_at: null })

  it('overlays newer windows by key and appends windows the older reading lacked', () => {
    const older = [window('five_hour', 10), window('seven_day', 50), window('model:Fable', 7)]
    const newer = [window('seven_day', 61), window('seven_day_opus', 3)]
    expect(mergeWindows(older, newer).map((w) => [w.key, w.utilization])).toEqual([
      ['five_hour', 10],
      ['seven_day', 61],
      ['model:Fable', 7],
      ['seven_day_opus', 3],
    ])
  })

  it('reads the weekly window from a weekly warning event', () => {
    expect(parseRateLimitEvent(WEEKLY_WARNING)?.windows).toEqual([
      { key: 'five_hour', label: '5-hour', utilization: 28, resets_at: '2026-10-02T11:10:00.000Z' },
      { key: 'seven_day', label: 'Weekly', utilization: 76, resets_at: '2026-10-03T23:00:00.000Z' },
    ])
  })

  const apiProbe: AccountProbe = {
    ...probeWith(identity()),
    usage: parseUsage(LIVE_USAGE),
  }

  it('takes a rate limit event newer than the usage API over its windows', () => {
    const event = observation('2026-09-26T12:03:00.000Z', WEEKLY_WARNING)
    const { usage, rate_limit_event: latest } = buildStatus(apiProbe, signals([event]), null)
    expect(usage?.source).toBe('mixed')
    expect(usage?.observed_at).toBe('2026-09-26T12:03:00.000Z')
    expect(usage?.windows.map((w) => [w.key, w.utilization])).toEqual([
      ['five_hour', 28],
      ['seven_day', 76],
      ['model:Fable', 7],
    ])
    expect(latest).toBe(event)
  })

  it('keeps the usage API when every event is older', () => {
    const event = observation('2026-09-26T11:59:00.000Z', WEEKLY_WARNING)
    const { usage } = buildStatus(apiProbe, signals([event]), null)
    expect(usage).toMatchObject({ source: 'usage_api', observed_at: '2026-09-26T12:00:00.000Z' })
    expect(usage?.windows.find((w) => w.key === 'seven_day')?.utilization).toBe(62)
  })

  it('keeps a window an older event reported when the newest event left it out', () => {
    const weeklyOnly = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 },
    }
    const events = [
      observation('2026-09-26T12:05:00.000Z', weeklyOnly),
      observation('2026-09-26T12:01:00.000Z', STREAM_EVENT),
    ]
    const { usage } = buildStatus(probeWith(identity()), signals(events), null)
    expect(usage).toMatchObject({ source: 'task_stream', observed_at: '2026-09-26T12:05:00.000Z' })
    expect(usage?.windows.map((w) => [w.key, w.utilization])).toEqual([
      ['five_hour', 17],
      ['seven_day', 80],
    ])
  })

  it('reports no usage without the usage API or any event', () => {
    expect(buildStatus(probeWith(identity()), signals([]), null).usage).toBeNull()
  })
})

describe('deriveHealth', () => {
  it('is ok on the Claude Code login', () => {
    expect(deriveHealth(probeWith(identity()), null, null)).toEqual({
      state: 'ok',
      message: 'Using the Claude Code login of me@example.com (Claude Max).',
    })
  })

  it('reports a logged-out machine', () => {
    const loggedOut = identity({ email: null, organization: null, subscription_type: null, token_source: 'none' })
    expect(deriveHealth(probeWith(loggedOut), null, null)).toEqual({
      state: 'logged_out',
      message: 'Claude Code is not logged in on this machine.',
    })
  })

  it.each<[string, Partial<AccountIdentity>, RegExp]>([
    ['an API key variable', { email: null, token_source: 'none', api_key_source: 'ANTHROPIC_API_KEY' }, /API key/],
    ['an apiKeyHelper', { api_key_source: 'apiKeyHelper' }, /apiKeyHelper/],
    ['a bearer token', { email: null, token_source: 'ANTHROPIC_AUTH_TOKEN' }, /ANTHROPIC_AUTH_TOKEN/],
    ['a cloud provider', { email: null, api_provider: 'bedrock' }, /bedrock/],
  ])('warns when agents use %s', (_name, overrides, message) => {
    const health = deriveHealth(probeWith(identity(overrides)), null, null)
    expect(health.state).toBe('api_key')
    expect(health.message).toMatch(message)
  })

  it('accepts a long-lived Claude Code OAuth token without an email', () => {
    const health = deriveHealth(
      probeWith(identity({ email: null, token_source: 'CLAUDE_CODE_OAUTH_TOKEN' })),
      null,
      null,
    )
    expect(health.state).toBe('ok')
  })

  it('is an error when Claude Code does not start', () => {
    expect(deriveHealth(probeWith(null, 'spawn failed'), null, null)).toEqual({
      state: 'error',
      message: 'Could not read the Claude Code login: spawn failed',
    })
  })

  it('surfaces a task login failure until something newer proves the login works', () => {
    expect(deriveHealth(probeWith(identity()), TASK_ERROR, null)).toEqual({
      state: 'error',
      message: 'A turn in "Fix login" failed with authentication_failed.',
    })
    expect(deriveHealth(probeWith(identity()), TASK_ERROR, '2026-09-26T12:00:00.000Z').state).toBe('error')
    expect(deriveHealth(probeWith(identity()), TASK_ERROR, '2026-09-26T13:00:00.000Z').state).toBe('ok')
  })

  it('reports logged out ahead of an older task failure', () => {
    const loggedOut = identity({ email: null, subscription_type: null, token_source: 'none' })
    expect(deriveHealth(probeWith(loggedOut), TASK_ERROR, null).state).toBe('logged_out')
  })
})

const INIT = {
  commands: [],
  agents: [],
  output_style: 'default',
  available_output_styles: [],
  models: [],
  account: { email: 'me@example.com', subscriptionType: 'Claude Max', apiProvider: 'firstParty' },
} satisfies SDKControlInitializeResponse

function fakeSession(
  usage: () => Promise<unknown> = async () => Promise.resolve(LIVE_USAGE),
  init: () => Promise<SDKControlInitializeResponse> = async () => Promise.resolve(INIT),
) {
  return {
    initializationResult: vi.fn(init),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(usage),
    close: vi.fn(),
  } satisfies AccountSession
}

const never = async () => new Promise<never>(() => undefined)

describe('probeAccount', () => {
  it('reads the login and usage without behaviors, then closes and aborts', async () => {
    const session = fakeSession()
    let signal: AbortSignal | undefined
    const probe = await probeAccount((s) => {
      signal = s
      return session
    }, FAST)
    expect(probe.error).toBeNull()
    expect(probe.account).toMatchObject({ email: 'me@example.com', subscription_type: 'Claude Max' })
    expect(probe.usage.ok).toBe(true)
    expect(session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET).toHaveBeenCalledWith({
      skipBehaviors: true,
    })
    expect(session.close).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(true)
  })

  it('treats a failing or hanging usage call as unavailable, not an error', async () => {
    const failing = await probeAccount(() => fakeSession(async () => Promise.reject(new Error('boom'))), FAST)
    expect(failing.error).toBeNull()
    expect(failing.usage).toEqual({ ok: false, reason: 'Plan usage is unavailable: boom' })
    const hanging = await probeAccount(() => fakeSession(never), { ...FAST, usageTimeoutMs: 10 })
    expect(hanging.usage).toMatchObject({ ok: false, reason: expect.stringMatching(/Timed out/) as unknown })
  })

  it('turns a stuck start into an error probe and still closes', async () => {
    const session = fakeSession(undefined, never)
    const probe = await probeAccount(() => session, { ...FAST, initTimeoutMs: 10 })
    expect(probe.account).toBeNull()
    expect(probe.error).toMatch(/Timed out/)
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('turns a throwing start into an error probe', async () => {
    const probe = await probeAccount(() => {
      throw new Error('no binary')
    }, FAST)
    expect(probe.error).toBe('no binary')
  })
})

describe('createAccountMonitor', () => {
  it('shares one in-flight probe, caches it and re-probes on refresh', async () => {
    const start = vi.fn(() => fakeSession())
    const monitor = createAccountMonitor(start, FAST)
    const [first, second] = await Promise.all([monitor.get(), monitor.refresh(), monitor.get()])
    expect(first).toBe(second)
    expect(start).toHaveBeenCalledOnce()
    expect(await monitor.get()).toBe(first)
    expect(start).toHaveBeenCalledOnce()
    const next = await monitor.refresh()
    expect(next).not.toBe(first)
    expect(start).toHaveBeenCalledTimes(2)
    expect(monitor.verifiedAt()).toBe(next.fetched_at)
  })

  it('keeps the last verified time when a later probe cannot read usage', async () => {
    let usable = true
    const monitor = createAccountMonitor(
      () => fakeSession(async () => Promise.resolve(usable ? LIVE_USAGE : { rate_limits_available: false })),
      FAST,
    )
    const verified = await monitor.refresh()
    usable = false
    const unverified = await monitor.refresh()
    expect(unverified.usage.ok).toBe(false)
    expect(monitor.verifiedAt()).toBe(verified.fetched_at)
  })
})

describe('task signals', () => {
  const taskId = '00000000-0000-4000-8000-0000000000a1'
  const sdk = async (payload: unknown) => {
    await messages.insert(taskId, { kind: 'sdk', payload: payload as SDKMessage }, [])
  }

  beforeAll(async () => {
    await tasks.insert({
      id: taskId,
      title: 'Nightly check',
      repo_id: null,
      cwd: scratch,
      worktree: false,
      pr_urls: [],
    })
  })

  it('finds nothing in an empty store', async () => {
    expect(await accountSignals.recentRateLimitEvents(5)).toEqual([])
    expect(await accountSignals.latestLoginFailure()).toBeUndefined()
    expect(await accountSignals.latestSuccessAt()).toBeNull()
  })

  it('reads the latest rate limit event, login failure and successful turn', async () => {
    await sdk({ type: 'assistant', error: 'rate_limit', message: { content: [] } })
    await sdk(STREAM_EVENT)
    await sdk({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    await sdk({
      type: 'assistant',
      error: 'authentication_failed',
      message: { content: [{ type: 'text', text: 'Invalid API key. Please run /login' }] },
    })
    await sdk({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key' })

    const [event] = await accountSignals.recentRateLimitEvents(5)
    expect(event && toRateLimitObservation(event)).toMatchObject({
      task_id: taskId,
      task_title: 'Nightly check',
      status: 'allowed',
    })
    const failure = await accountSignals.latestLoginFailure()
    expect(failure && toTaskLoginError(failure)).toMatchObject({
      task_title: 'Nightly check',
      error: 'authentication_failed',
      message: 'Invalid API key. Please run /login',
    })
    expect(await accountSignals.latestSuccessAt()).not.toBeNull()
  })

  it('reads an auth status on a failed result', async () => {
    await sdk({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      result: 'OAuth token expired',
    })
    const failure = await accountSignals.latestLoginFailure()
    expect(failure && toTaskLoginError(failure)).toMatchObject({ error: 'HTTP 401', message: 'OAuth token expired' })
  })

  it('falls back to the task stream for usage when the usage API has nothing', async () => {
    const events = await accountSignals.recentRateLimitEvents(5)
    const status = buildStatus(
      { ...probeWith(identity()), usage: { ok: false, reason: 'Plan limits do not apply to this login' } },
      {
        rateLimitEvents: events.flatMap((event) => toRateLimitObservation(event) ?? []),
        loginFailure: null,
        lastSuccessAt: null,
      },
      null,
    )
    expect(status.usage).toMatchObject({ source: 'task_stream', windows: [{ key: 'five_hour' }, { key: 'seven_day' }] })
    expect(status.usage_note).toBe('Plan limits do not apply to this login')
  })
})
