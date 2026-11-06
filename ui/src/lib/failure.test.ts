import { NO_LOGINS, type AccountStatus, type McpSessionState, type UsageWindow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { classifyFailure, mcpFailureHint, rateLimitResetAt } from './failure'

describe('classifyFailure', () => {
  it.each([
    ['Claude Code process exited with code 1: rate limit reached for requests', 'rate_limit'],
    ['API Error: 429 {"type":"rate_limit_error"}', 'rate_limit'],
    ['Claude AI usage limit reached|1759420800', 'rate_limit'],
    ['Your credit balance is too low to access the Anthropic API', 'billing'],
    ['Invalid API key, please run /login', 'auth'],
    ['API Error: 401 {"type":"authentication_error","message":"OAuth token has expired"}', 'auth'],
    ['MCP server "langfuse" connection failed: connect ECONNREFUSED 127.0.0.1:3000', 'mcp'],
    ['API Error: 529 {"type":"overloaded_error","message":"Overloaded"}', 'api'],
    ['request to https://api.anthropic.com failed: getaddrinfo ENOTFOUND api.anthropic.com', 'network'],
    ['bwrap: Operation not permitted', 'sandbox'],
    ['Claude Code process exited with code 1', 'crash'],
    ['Claude Code process terminated by signal SIGKILL', 'crash'],
    ['error_max_turns', 'step_limit'],
    ['error_max_budget_usd', 'cost_limit'],
    ['Something odd happened', 'unknown'],
  ])('reads %s as %s', (raw, kind) => {
    expect(classifyFailure(raw).kind).toBe(kind)
  })

  it('says what happened in a short sentence, with what to do when Seti knows', () => {
    expect(classifyFailure('rate limit reached')).toEqual({
      kind: 'rate_limit',
      title: 'Rate limit reached.',
      hint: 'Retry the turn once the limit resets.',
    })
    expect(classifyFailure('').title).toBe('The turn failed.')
  })

  it('names a session that could not start by its cause, on one short line', () => {
    expect(classifyFailure("Couldn't start: bwrap: Operation not permitted\nat spawn")).toEqual({
      kind: 'sandbox',
      title: "Couldn't start: bwrap: Operation not permitted",
      hint: "Check the agent's sandbox and access, or turn the sandbox off for it.",
    })
    const long = classifyFailure(`Couldn't start: ${'x'.repeat(300)}`)
    expect(long).toMatchObject({
      kind: 'unknown',
      hint: 'Retry the turn or restart the session once the cause is fixed.',
    })
    expect(long.title).toHaveLength(120)
  })
})

const NOW = Date.parse('2026-10-02T15:00:00Z')

function window(key: string, utilization: number | null, resets: string | null): UsageWindow {
  return { key, label: key, utilization, resets_at: resets }
}

function account(windows: UsageWindow[], event: AccountStatus['rate_limit_event'] = null): AccountStatus {
  return {
    account: null,
    logins: NO_LOGINS,
    health: { state: 'ok', message: '' },
    usage: { source: 'usage_api', observed_at: '2026-10-02T14:59:00Z', windows },
    usage_note: null,
    rate_limit_event: event,
    task_error: null,
    fetched_at: '2026-10-02T14:59:00Z',
  }
}

describe('rateLimitResetAt', () => {
  it('takes the latest reset of the windows that are full', () => {
    const status = account([
      window('five_hour', 100, '2026-10-02T17:40:00Z'),
      window('seven_day', 100, '2026-10-05T09:00:00Z'),
      window('seven_day_opus', 40, '2026-10-03T09:00:00Z'),
    ])
    expect(rateLimitResetAt(status, NOW)).toBe('2026-10-05T09:00:00Z')
  })

  it('falls back to the soonest window of a rejected rate limit event', () => {
    const event = {
      task_id: 't',
      task_title: 'Agent',
      at: '2026-10-02T14:58:00Z',
      status: 'rejected',
      rate_limit_type: 'five_hour',
      windows: [window('five_hour', null, '2026-10-02T17:40:00Z'), window('seven_day', null, '2026-10-06T00:00:00Z')],
    }
    expect(rateLimitResetAt(account([window('five_hour', 60, '2026-10-02T17:40:00Z')], event), NOW)).toBe(
      '2026-10-02T17:40:00Z',
    )
  })

  it('knows nothing without usage, or when every reset has passed', () => {
    expect(rateLimitResetAt(undefined, NOW)).toBeNull()
    expect(rateLimitResetAt(account([window('five_hour', 100, '2026-10-02T14:00:00Z')]), NOW)).toBeNull()
    expect(rateLimitResetAt(account([window('five_hour', 50, '2026-10-02T17:40:00Z')]), NOW)).toBeNull()
  })
})

const state = (
  status: McpSessionState['status'],
  reason: string | null,
  signIn: McpSessionState['sign_in'] = 'none',
): McpSessionState => ({
  status,
  reason,
  sign_in: signIn,
  at: '2026-10-02T14:00:00Z',
})

describe('mcpFailureHint', () => {
  it('names each kind of failure in plain words', () => {
    expect(mcpFailureHint(state('failed', 'connect ECONNREFUSED 127.0.0.1:3000'))).toBe(
      'Server not reachable: check it is running.',
    )
    expect(mcpFailureHint(state('failed', 'HTTP 401 Unauthorized'))).toBe('Needs sign-in.')
    expect(mcpFailureHint(state('failed', 'spawn langfuse-mcp ENOENT'))).toBe(
      'Server command not found: check its command in Settings, MCP servers.',
    )
    expect(mcpFailureHint(state('failed', 'Connection timed out after 30000ms'))).toBe(
      'Server did not answer in time: check it is running.',
    )
    expect(mcpFailureHint(state('failed', null))).toBe('Server failed to start.')
    expect(mcpFailureHint(state('needs-auth', 'Not signed in.', 'required'))).toBe('Needs sign-in.')
    expect(mcpFailureHint(state('needs-auth', null))).toBe('Needs sign-in: run /mcp in claude on the host.')
  })

  it('leaves working and missing servers to their own reason', () => {
    expect(mcpFailureHint(state('connected', null))).toBeNull()
    expect(mcpFailureHint(state('not_loaded', 'Its plugin is not loaded for this agent.'))).toBeNull()
  })
})
