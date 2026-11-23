import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKRateLimitEvent,
  SDKResultMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { TURN_COST_KEY } from '../../cost.js'
import type { RuntimeEvent } from '../../events.js'
import { isRecord } from '../../lenient.js'
import { num, some, str } from './fields.js'
import { toolResults, userText } from './results.js'
import { systemEvent } from './system.js'
import { claudeToolCall } from './tools.js'

type Event = RuntimeEvent

/** Assistant message errors that mean the login or its billing is broken. */
const LOGIN_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
])

const ENDINGS = new Map<string, 'error' | 'turn_limit' | 'budget_limit' | 'retry_limit'>([
  ['error_during_execution', 'error'],
  ['error_max_turns', 'turn_limit'],
  ['error_max_budget_usd', 'budget_limit'],
  ['error_max_structured_output_retries', 'retry_limit'],
])

const LOCAL_OUTPUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/
const INTERRUPTED = '[Request interrupted by user'

function block(m: SDKAssistantMessage, thread: string, value: unknown, index: number): Event {
  const id = `${m.uuid}:${String(index)}`
  const type = str(value, 'type')
  if (type === 'text') {
    return { v: 1, thread, type: 'message', id, role: 'agent', text: str(value, 'text') ?? '' }
  }
  if (type === 'thinking' || type === 'redacted_thinking') {
    return { v: 1, thread, type: 'reasoning', id, text: str(value, 'thinking') ?? '', summary: false }
  }
  if (type === 'tool_use') {
    const call = claudeToolCall(
      str(value, 'id') ?? '',
      str(value, 'name') ?? '',
      isRecord(value) ? value.input : undefined,
    )
    return { v: 1, thread, type: 'tool.started', call }
  }
  return { v: 1, thread, type: 'vendor', name: `assistant/${type ?? 'unknown'}` }
}

function errorCode(error: string): 'auth' | 'rate_limited' | 'info' {
  if (LOGIN_ERRORS.has(error)) {
    return 'auth'
  }
  return error === 'rate_limit' ? 'rate_limited' : 'info'
}

function assistant(m: SDKAssistantMessage): Event[] {
  const thread = m.parent_tool_use_id ?? ''
  const blocks = m.message.content.map((value, index) => block(m, thread, value, index))
  return m.error === undefined
    ? blocks
    : [...blocks, { v: 1, thread, type: 'notice', code: errorCode(m.error), text: m.error }]
}

/** What a user message's text is: a local command's output, an interruption, or plain text. */
function textEvent(m: SDKUserMessage, thread: string, text: string): Event {
  const local = LOCAL_OUTPUT.exec(text.trim())
  if (local !== null) {
    return { v: 1, thread, type: 'message', id: m.uuid ?? '', role: 'command', text: (local[1] ?? '').trim() }
  }
  if (text.startsWith(INTERRUPTED)) {
    return { v: 1, thread, type: 'notice', code: 'interrupted', text }
  }
  return { v: 1, thread, type: 'message', id: m.uuid ?? '', role: 'user', text, ...some('synthetic', m.isSynthetic) }
}

function user(m: SDKUserMessage): Event[] {
  const thread = m.parent_tool_use_id ?? ''
  const { content } = m.message
  const results = toolResults(content, thread, m.tool_use_result)
  const text = userText(content)
  return text === null ? results : [...results, textEvent(m, thread, text)]
}

function usageOf(usage: unknown) {
  const input = num(usage, 'input_tokens')
  const output = num(usage, 'output_tokens')
  if (input === undefined || output === undefined) {
    return undefined
  }
  return {
    input,
    output,
    ...some('cacheRead', num(usage, 'cache_read_input_tokens')),
    ...some('cacheWrite', num(usage, 'cache_creation_input_tokens')),
  }
}

/** The turn a result ends. Claude Code's cost is a session total; the turn's share is Seti's. */
function result(m: SDKResultMessage): Event {
  const text = m.subtype === 'success' ? (str(m, 'result') ?? '') : ''
  const answered = m.user_message_uuids ?? (m.user_message_uuid === undefined ? [] : [m.user_message_uuid])
  return {
    v: 1,
    thread: '',
    type: 'turn.ended',
    turnId: m.uuid,
    status: m.is_error ? 'error' : 'ok',
    result: text,
    ...(m.is_error ? { error: m.subtype === 'success' ? text : m.subtype } : {}),
    ...(m.subtype === 'success' ? {} : { ending: ENDINGS.get(m.subtype) ?? 'other' }),
    cause: m.origin?.kind === 'task-notification' ? 'background' : 'input',
    steps: m.num_turns,
    ...some('costUsd', num(m, TURN_COST_KEY)),
    durationMs: m.duration_ms,
    ...some('usage', usageOf(m.usage)),
    answered,
    ...some('apiStatus', num(m, 'api_error_status')),
  }
}

/** A message's type and subtype, as a vendor event names it. */
function vendorName(m: unknown): string {
  const name = [str(m, 'type'), str(m, 'subtype')].filter((part) => part !== undefined).join('/')
  return name === '' ? 'unknown' : name
}

/** A message Seti does not map, on the thread the message names, if it names one. */
const vendor = (name: string, m?: unknown): Event => ({
  v: 1,
  thread: str(m, 'parent_tool_use_id') ?? '',
  type: 'vendor',
  name,
})

function progress(m: SDKToolProgressMessage): Event {
  const thread = m.parent_tool_use_id ?? ''
  return { v: 1, thread, type: 'tool.progress', callId: m.tool_use_id, elapsedMs: m.elapsed_time_seconds * 1000 }
}

/** A rate limit event is news only when the limit turned the agent away. */
const rateLimit = (m: SDKRateLimitEvent): Event =>
  m.rate_limit_info.status === 'rejected'
    ? { v: 1, thread: '', type: 'notice', code: 'rate_limited', text: m.rate_limit_info.status }
    : vendor(m.type)

function events(m: SDKMessage): Event[] {
  if (m.type === 'assistant') {
    return assistant(m)
  }
  if (m.type === 'user') {
    return user(m)
  }
  if (m.type === 'result') {
    return [result(m)]
  }
  if (m.type === 'system') {
    return [systemEvent(m)]
  }
  if (m.type === 'tool_progress') {
    return [progress(m)]
  }
  return [m.type === 'rate_limit_event' ? rateLimit(m) : vendor(vendorName(m), m)]
}

/**
 * The neutral events of one stored Claude Code message, in the order it holds them. Pure and
 * stateless: a tool's start and end arrive in different messages and are joined by `callId`.
 * A message it cannot read becomes one `vendor` event, so it never breaks the rows around it.
 */
export function projectClaude(m: SDKMessage): RuntimeEvent[] {
  try {
    return events(m)
  } catch {
    return [vendor(vendorName(m), m)]
  }
}
