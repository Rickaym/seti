import { startFailureReason, type AccountStatus, type McpSessionState, type UsageWindow } from '@seti/shared'

type FailureKind =
  | 'rate_limit'
  | 'billing'
  | 'auth'
  | 'mcp'
  | 'api'
  | 'network'
  | 'sandbox'
  | 'crash'
  | 'step_limit'
  | 'cost_limit'
  | 'interrupted'
  | 'unknown'

/** A failed turn in plain words: what happened and, when Seti knows, what to do about it. */
export interface Failure {
  kind: FailureKind
  title: string
  hint: string | null
}

interface Rule {
  kind: FailureKind
  test: RegExp
  title: string
  hint: string
}

const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|fetch failed|socket hang up/i

/** First match wins, so a rate limit that ended the process reads as a rate limit. */
const RULES: readonly Rule[] = [
  {
    kind: 'rate_limit',
    test: /rate[ _-]?limit|usage limit|too many requests|\b429\b|limit reached|quota/i,
    title: 'Rate limit reached.',
    hint: 'Retry the turn once the limit resets.',
  },
  {
    kind: 'billing',
    test: /billing|credit balance|out of credits|account[ _]on[ _]hold|payment/i,
    title: 'The Claude account cannot pay for this turn.',
    hint: 'Check the plan in Settings, Account.',
  },
  {
    kind: 'auth',
    test: /authenticat|unauthori[sz]ed|\b401\b|invalid api key|\/login|not logged in|log ?in again|oauth|token (has )?expired/i,
    title: 'Claude Code is not logged in.',
    hint: 'Log in to Claude Code on the host, then retry. Settings, Account shows the login.',
  },
  {
    kind: 'mcp',
    test: /\bmcp\b/i,
    title: 'An MCP server failed.',
    hint: "Check the server in the agent's access, then retry.",
  },
  {
    kind: 'api',
    test: /overloaded|\b5\d\d\b|internal server error|server_error|api error/i,
    title: 'The Claude API failed.',
    hint: 'This is usually brief. Retry in a minute.',
  },
  {
    kind: 'network',
    test: new RegExp(`${UNREACHABLE.source}|ETIMEDOUT|network|timed out`, 'i'),
    title: 'Seti could not reach the Claude API.',
    hint: "Check the host's network, then retry.",
  },
  {
    kind: 'sandbox',
    test: /sandbox|bwrap|bubblewrap|seccomp|operation not permitted|\bEPERM\b|\bEACCES\b|permission denied/i,
    title: 'The sandbox refused an operation.',
    hint: "Check the agent's sandbox and access, or turn the sandbox off for it.",
  },
  {
    kind: 'crash',
    test: /exited with code|process exited|terminated|\bSIG[A-Z]+\b|killed|out of memory|ENOMEM|spawn/i,
    title: 'Claude Code stopped unexpectedly.',
    hint: 'Restart the session, then retry the turn.',
  },
]

const LIMITS: Readonly<Record<string, Failure>> = {
  error_max_turns: { kind: 'step_limit', title: 'The turn hit its step limit.', hint: 'Retry to let it go on.' },
  error_max_budget_usd: { kind: 'cost_limit', title: 'The turn hit its cost limit.', hint: null },
}

export const INTERRUPTED: Failure = {
  kind: 'interrupted',
  title: 'Seti restarted while this turn ran.',
  hint: 'Retry the turn to pick up where it stopped.',
}

const START_HINT = 'Retry the turn or restart the session once the cause is fixed.'

/**
 * What a failed turn's error text means; an error subtype such as error_max_turns counts too. A
 * session that could not start says so with its cause, and the matching rule's hint if any.
 */
export function classifyFailure(raw: string): Failure {
  const limit = LIMITS[raw.trim()]
  if (limit !== undefined) {
    return limit
  }
  const rule = RULES.find(({ test }) => test.test(raw))
  const start = startFailureReason(raw)
  if (start !== null) {
    return { kind: rule?.kind ?? 'unknown', title: start, hint: rule?.hint ?? START_HINT }
  }
  return rule === undefined
    ? { kind: 'unknown', title: 'The turn failed.', hint: null }
    : { kind: rule.kind, title: rule.title, hint: rule.hint }
}

const future = (window: UsageWindow, now: number) =>
  window.resets_at !== null && new Date(window.resets_at).getTime() > now

const resetTime = (window: UsageWindow) => new Date(window.resets_at ?? 0).getTime()

/** The binding reset: the latest of the full windows, else the soonest of a rejected event. */
export function rateLimitResetAt(account: AccountStatus | undefined, now: number = Date.now()): string | null {
  if (account === undefined) {
    return null
  }
  const event = account.rate_limit_event
  const windows = [...(account.usage?.windows ?? []), ...(event?.windows ?? [])].filter((w) => future(w, now))
  const full = windows.filter((w) => (w.utilization ?? 0) >= 100).toSorted((a, b) => resetTime(b) - resetTime(a))
  const named = event?.status === 'rejected' ? event.windows.filter((w) => future(w, now)) : []
  const pick = full[0] ?? named.toSorted((a, b) => resetTime(a) - resetTime(b))[0]
  return pick?.resets_at ?? null
}

/** Why an MCP server the agent's latest session could not use failed, in plain words. */
export function mcpFailureHint(state: McpSessionState): string | null {
  if (state.status === 'needs-auth') {
    return state.sign_in === 'none' ? 'Needs sign-in: run /mcp in claude on the host.' : 'Needs sign-in.'
  }
  if (state.status !== 'failed') {
    return null
  }
  const reason = state.reason ?? ''
  if (UNREACHABLE.test(reason)) {
    return 'Server not reachable: check it is running.'
  }
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|authenticat/i.test(reason)) {
    return 'Needs sign-in.'
  }
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(reason)) {
    return 'Server did not answer in time: check it is running.'
  }
  if (/ENOENT|not found|spawn/i.test(reason)) {
    return 'Server command not found: check its command in Settings, MCP servers.'
  }
  return 'Server failed to start.'
}
