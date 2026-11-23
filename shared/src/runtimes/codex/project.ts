import type { RuntimeEvent } from '../../events.js'
import { callOf, endOf, isCall } from './calls.js'
import {
  agentMessage,
  errorNotice,
  itemParams,
  planUpdate,
  reasoning,
  stored,
  threadStarted,
  tokenUsage,
  turnParams,
  userInputAnswer,
  userInputRequest,
  userMessage,
  type Item,
} from './shapes.js'

type Event = RuntimeEvent

interface Thread {
  thread: string
}

/** A Codex app-server message as Seti stores it: as Codex sent it, beside the agent's own thread. */
export interface CodexMessage {
  /** The id of the thread the agent itself runs in; any other thread is a subagent's. */
  root: string
  /** The notification, or the request Codex sent, unchanged. */
  message: unknown
  /** Seti's answer to that request, on the row that records the answer. */
  reply?: unknown
}

type Vendor = Extract<Event, { type: 'vendor' }>

const vendor = (thread: string, name: string): Vendor => ({ v: 1, thread, type: 'vendor', name })

function started(item: Item, at: Thread): Event {
  if (item.type === 'contextCompaction') {
    return { v: 1, ...at, type: 'compaction', phase: 'started' }
  }
  const call = callOf(item)
  return call === null ? vendor(at.thread, `item/started ${item.type}`) : { v: 1, ...at, type: 'tool.started', call }
}

const userText = (item: Item) =>
  userMessage
    .parse(item)
    .content.flatMap((part) => (part.text === undefined ? [] : [part.text]))
    .join('\n')

function completed(item: Item, at: Thread): Event {
  switch (item.type) {
    case 'userMessage':
      return { v: 1, ...at, type: 'message', id: item.id, role: 'user', text: userText(item) }
    case 'agentMessage':
      return { v: 1, ...at, type: 'message', id: item.id, role: 'agent', text: agentMessage.parse(item).text }
    case 'reasoning': {
      const text = reasoning.parse(item).summary.join('\n')
      return { v: 1, ...at, type: 'reasoning', id: item.id, text, summary: true }
    }
    case 'contextCompaction':
      return { v: 1, ...at, type: 'compaction', phase: 'done' }
    default:
      return isCall(item.type) ? endOf(item, at.thread) : vendor(at.thread, `item/completed ${item.type}`)
  }
}

const TURN_STATUS = { completed: 'ok', interrupted: 'interrupted', failed: 'error', inProgress: 'error' } as const

function turnEnded(params: unknown, at: Thread): Event {
  const { turn } = turnParams.parse(params)
  const reply = turn.items.filter((item) => item.type === 'agentMessage').at(-1)
  const error = turn.error?.message
  return {
    v: 1,
    ...at,
    type: 'turn.ended',
    turnId: turn.id,
    status: TURN_STATUS[turn.status],
    result: reply === undefined ? '' : agentMessage.parse(reply).text,
    cause: 'input',
    answered: [],
    ...(error === undefined ? {} : { error }),
    ...(typeof turn.durationMs === 'number' ? { durationMs: turn.durationMs } : {}),
  }
}

function sessionStarted(params: unknown, root: string): Event {
  const { thread } = threadStarted.parse(params)
  if (thread.id !== root) {
    return vendor(thread.id, 'thread/started')
  }
  const cwd = thread.environments?.[0]?.cwd
  const base = { v: 1, thread: '', type: 'session.started', sessionId: thread.id } as const
  return { ...base, model: thread.model ?? '', mode: null, servers: [], ...(cwd === undefined ? {} : { cwd }) }
}

function usage(params: unknown, at: Thread): Event {
  const { last, modelContextWindow } = tokenUsage.parse(params).tokenUsage
  const counts = {
    input: last.inputTokens - last.cachedInputTokens,
    output: last.outputTokens,
    cacheRead: last.cachedInputTokens,
    reasoning: last.reasoningOutputTokens,
    ...(last.cacheWriteInputTokens === undefined ? {} : { cacheWrite: last.cacheWriteInputTokens }),
  }
  const window = typeof modelContextWindow === 'number' ? { contextWindow: modelContextWindow } : {}
  return { v: 1, ...at, type: 'usage', usage: counts, ...window }
}

const PLAN_STATUS = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' } as const

function plan(params: unknown, at: Thread): Event {
  const items = planUpdate
    .parse(params)
    .plan.map((step, index) => ({ id: String(index + 1), text: step.step, status: PLAN_STATUS[step.status] }))
  return { v: 1, ...at, type: 'plan', items }
}

/** Errors Codex retries are news while they last; a refused key or a limit says why. */
function notice(params: unknown, at: Thread): Event {
  const { error, willRetry } = errorNotice.parse(params)
  const info = JSON.stringify(error.codexErrorInfo ?? '')
  const fallback = willRetry ? 'api_retry' : 'info'
  const limited = /rateLimitExceeded|usageLimitExceeded|"httpStatusCode":429/.test(info) ? 'rate_limited' : fallback
  const code = /unauthorized|"httpStatusCode":40[13]/.test(info) ? 'auth' : limited
  return { v: 1, ...at, type: 'notice', code, text: error.message }
}

function question(params: unknown, at: Thread): Event {
  const { itemId, questions } = userInputRequest.parse(params)
  const asked = questions.map((one) => ({
    text: one.question,
    options: (one.options ?? []).map((option) => option.label),
    ...(one.header === null || one.header === undefined ? {} : { header: one.header }),
  }))
  const call = { callId: itemId, kind: 'question', name: 'request_user_input', input: params } as const
  return { v: 1, ...at, type: 'tool.started', call: { ...call, question: { questions: asked } } }
}

function answered(params: unknown, reply: unknown, at: Thread): Event {
  const { itemId, questions } = userInputRequest.parse(params)
  const { answers } = userInputAnswer.parse(reply)
  const lines = questions.map((one) => `${one.question} ${(answers[one.id]?.answers ?? []).join(', ')}`)
  const result = { text: lines.join('\n'), images: 0 }
  const status = Object.keys(answers).length === 0 ? 'cancelled' : 'ok'
  return { v: 1, ...at, type: 'tool.ended', callId: itemId, status, result }
}

type Mapper = (params: unknown, at: Thread, root: string) => Event

/** Rows that record Seti's answer to a request, by the request's method. */
const REPLIED: Partial<Record<string, (params: unknown, reply: unknown, at: Thread) => Event>> = {
  'item/tool/requestUserInput': answered,
}

const MAPPED: Partial<Record<string, Mapper>> = {
  'thread/started': (params, _at, root) => sessionStarted(params, root),
  'thread/resume': (params, _at, root) => sessionStarted(params, root),
  'turn/started': (params, at) => ({
    v: 1,
    ...at,
    type: 'turn.started',
    turnId: turnParams.parse(params).turn.id,
    cause: 'input',
  }),
  'turn/completed': turnEnded,
  'item/started': (params, at) => started(itemParams.parse(params).item, at),
  'item/completed': (params, at) => completed(itemParams.parse(params).item, at),
  'thread/tokenUsage/updated': usage,
  'turn/plan/updated': plan,
  error: notice,
  'item/tool/requestUserInput': question,
}

function projectReply(message: { method: string; params?: unknown }, reply: unknown, at: Thread): Event[] {
  const map = REPLIED[message.method]
  if (map === undefined) {
    return [vendor(at.thread, message.method)]
  }
  try {
    return [map(message.params, reply, at)]
  } catch {
    return [{ ...vendor(at.thread, message.method), unreadable: true }]
  }
}

/** The thread a message belongs to: empty for the agent's own, else the subagent's thread id. */
function threadOf(params: unknown, root: string): string {
  const id = typeof params === 'object' && params !== null ? (params as { threadId?: unknown }).threadId : undefined
  return typeof id === 'string' && id !== root ? id : ''
}

/**
 * The neutral events of one stored Codex message. Pure and stateless: a call's start and end
 * arrive in different messages and are joined by `callId`. A message of a known method whose
 * shape does not fit becomes `vendor` marked unreadable; any other method becomes plain `vendor`.
 */
export function projectCodex(raw: unknown): RuntimeEvent[] {
  const envelope = stored.safeParse(raw)
  if (!envelope.success) {
    return [{ ...vendor('', 'codex'), unreadable: true }]
  }
  const { root, message, reply } = envelope.data
  const at = { thread: threadOf(message.params, root) }
  if (reply !== undefined) {
    return projectReply(message, reply, at)
  }
  const map = MAPPED[message.method]
  if (map === undefined) {
    return [vendor(at.thread, message.method)]
  }
  try {
    return [map(message.params, at, root)]
  } catch {
    return [{ ...vendor(at.thread, message.method), unreadable: true }]
  }
}
