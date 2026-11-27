import type { RuntimeEvent } from '../../events.js'
import { callOf, resultOf } from './calls.js'
import { acpRecord, sessionUpdate, type AcpRecord } from './shapes.js'

type Event = RuntimeEvent

type Update = ReturnType<typeof sessionUpdate.parse>

const AGENT = { v: 1, thread: '' } as const

const vendor = (name: string, unreadable = false): Event => ({
  ...AGENT,
  type: 'vendor',
  name,
  ...(unreadable ? { unreadable: true as const } : {}),
})

/** A chunk's text, or a mark naming a part that is not text. */
const chunkText = (update: Extract<Update, { content: unknown }>) =>
  'text' in update.content && typeof update.content.text === 'string' ? update.content.text : `[${update.content.type}]`

/** Gemini CLI opens a thought with its subject in bold; an empty subject leaves `****`. */
const thoughtText = (text: string) => text.replace(/^\*\*\*\*\n/, '')

const ENDED = { completed: 'ok', failed: 'error' } as const

/** A call's end, when the update reports one: denied where Seti refused it. */
function callEnded(update: Extract<Update, { toolCallId: string }>, denied: boolean): Event[] {
  if (update.status !== 'completed' && update.status !== 'failed') {
    return []
  }
  const status = denied ? 'denied' : ENDED[update.status]
  return [{ ...AGENT, type: 'tool.ended', callId: update.toolCallId, status, result: resultOf(update) }]
}

function updateEvents(id: string, update: Update, denied: boolean): Event[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return [{ ...AGENT, type: 'message', id, role: 'agent', text: chunkText(update) }]
    case 'user_message_chunk':
      return [{ ...AGENT, type: 'message', id, role: 'user', text: chunkText(update) }]
    case 'agent_thought_chunk':
      return [{ ...AGENT, type: 'reasoning', id, text: thoughtText(chunkText(update)), summary: false }]
    case 'tool_call':
      return [{ ...AGENT, type: 'tool.started', call: callOf(update) }, ...callEnded(update, denied)]
    case 'tool_call_update':
      return callEnded(update, denied)
    case 'plan':
      return [
        {
          ...AGENT,
          type: 'plan',
          items: update.entries.map((entry, index) => ({
            id: String(index),
            text: entry.content,
            status: entry.status,
          })),
        },
      ]
  }
}

function fromUpdate(record: Extract<AcpRecord, { seti: 'update' }>): Event[] {
  const kind = (record.update as { sessionUpdate?: unknown } | null)?.sessionUpdate
  const name = typeof kind === 'string' ? kind : 'update'
  const parsed = sessionUpdate.safeParse(record.update)
  if (parsed.success) {
    return updateEvents(record.id, parsed.data, record.denied === true)
  }
  return [
    vendor(
      name,
      sessionUpdate.options.some((option) => option.shape.sessionUpdate.value === name),
    ),
  ]
}

type PromptUsage = NonNullable<Extract<AcpRecord, { seti: 'ended' }>['usage']>

type Tokens = NonNullable<Extract<Event, { type: 'turn.ended' }>['usage']>

/** A turn's tokens in Seti's terms; counts the agent left out or sent as null stay out. */
function tokensOf(usage: PromptUsage): Tokens {
  const tokens: Tokens = { input: usage.inputTokens, output: usage.outputTokens }
  if (typeof usage.cachedReadTokens === 'number') {
    tokens.cacheRead = usage.cachedReadTokens
  }
  if (typeof usage.cachedWriteTokens === 'number') {
    tokens.cacheWrite = usage.cachedWriteTokens
  }
  if (typeof usage.thoughtTokens === 'number') {
    tokens.reasoning = usage.thoughtTokens
  }
  return tokens
}

const ENDINGS: Record<string, 'turn_limit' | 'other'> = {
  max_turn_requests: 'turn_limit',
  max_tokens: 'other',
  refusal: 'other',
}

function turnEnded(record: Extract<AcpRecord, { seti: 'ended' }>): Event[] {
  const finished = record.stopReason === 'cancelled' ? 'interrupted' : 'ok'
  const status = record.error === undefined ? finished : 'error'
  const ending = ENDINGS[record.stopReason]
  const { usage } = record
  const stopped: Event[] = (record.unfinished ?? []).map((callId) => ({
    ...AGENT,
    type: 'tool.ended',
    callId,
    status: 'cancelled',
    result: { text: '', images: 0 },
  }))
  return [
    ...stopped,
    {
      ...AGENT,
      type: 'turn.ended',
      turnId: record.turnId,
      status,
      result: record.result,
      cause: 'input',
      answered: [],
      ...(ending === undefined ? {} : { ending }),
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(usage === null ? {} : { usage: tokensOf(usage) }),
      ...(record.usd === undefined ? {} : { costUsd: record.usd, costEstimated: true as const }),
    },
  ]
}

/** The neutral events of one ACP record as Seti stored it; anything it cannot read is `vendor`. */
export function projectAcp(raw: unknown): Event[] {
  const parsed = acpRecord.safeParse(raw)
  if (!parsed.success) {
    return [vendor('acp', true)]
  }
  const record = parsed.data
  switch (record.seti) {
    case 'started':
      return [
        {
          ...AGENT,
          type: 'session.started',
          sessionId: record.sessionId,
          model: record.model,
          mode: null,
          servers: [],
          cwd: record.cwd,
        },
      ]
    case 'turn':
      return [{ ...AGENT, type: 'turn.started', turnId: record.turnId, cause: 'input' }]
    case 'update':
      return fromUpdate(record)
    case 'ended':
      return turnEnded(record)
  }
}
