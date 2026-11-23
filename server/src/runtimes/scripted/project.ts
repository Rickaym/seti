import { eventsOf, isAgentOutput, type RuntimeEvent } from '@seti/shared'
import type { SessionMessage } from '../adapter.js'
import { conversationLines, type ScriptedLine } from './dialect.js'
import { scriptedToolCall } from './tools.js'

type Of<T extends ScriptedLine['t']> = Extract<ScriptedLine, { t: T }>

const HANDLERS: { [T in ScriptedLine['t']]: (line: Of<T>) => RuntimeEvent } = {
  hello: (line) => ({
    v: 1,
    thread: '',
    type: 'session.started',
    sessionId: line.session,
    model: line.model,
    mode: null,
    servers: [],
  }),
  begin: (line) => ({ v: 1, thread: '', type: 'turn.started', turnId: line.turn, cause: 'input' }),
  say: (line) => ({ v: 1, thread: line.thread ?? '', type: 'message', id: line.id, role: 'agent', text: line.text }),
  think: (line) => ({
    v: 1,
    thread: line.thread ?? '',
    type: 'reasoning',
    id: line.id,
    text: line.text,
    summary: false,
  }),
  call: (line) => ({ v: 1, thread: line.thread ?? '', type: 'tool.started', call: scriptedToolCall(line.call) }),
  done: (line) => ({
    v: 1,
    thread: line.thread ?? '',
    type: 'tool.ended',
    callId: line.id,
    status: line.status,
    result: { text: line.output, images: 0, ...(line.exit === undefined ? {} : { exitCode: line.exit }) },
  }),
  job: (line) =>
    line.phase === 'start'
      ? {
          v: 1,
          thread: '',
          type: 'job.started',
          jobId: line.job,
          callId: line.call,
          kind: line.kind ?? 'shell',
          label: line.label,
          background: true,
        }
      : {
          v: 1,
          thread: '',
          type: 'job.ended',
          jobId: line.job,
          callId: line.call,
          status: line.status ?? 'completed',
          summary: line.label,
        },
  plan: (line) => ({
    v: 1,
    thread: '',
    type: 'plan',
    items: line.items.map((item, index) => ({ id: String(index + 1), ...item })),
  }),
  model: (line) => ({ v: 1, thread: '', type: 'model.changed', from: line.from, to: line.to, reason: 'fallback' }),
  compact: (line) => ({
    v: 1,
    thread: '',
    type: 'compaction',
    phase: line.phase,
    trigger: line.trigger,
    ...(line.before === undefined ? {} : { before: line.before }),
  }),
  end: (line) => ({
    v: 1,
    thread: '',
    type: 'turn.ended',
    turnId: line.turn,
    status: line.status,
    result: line.reply,
    cause: 'input',
    costUsd: line.usd,
    usage: { input: line.tokens.in, output: line.tokens.out },
    answered: line.inputs,
  }),
}

const isKnown = (t: string): t is ScriptedLine['t'] => Object.hasOwn(conversationLines, t)

const typeOf = (raw: unknown): string | null =>
  typeof raw === 'object' && raw !== null && 't' in raw && typeof raw.t === 'string' ? raw.t : null

const unreadable = (name: string): RuntimeEvent => ({ v: 1, thread: '', type: 'vendor', name, unreadable: true })

/**
 * The neutral events of one line the scripted runtime wrote. Pure and stateless. A line that is
 * not a JSON object with a type, or a known type in a shape this cannot read, is `unreadable`;
 * a type it does not know is a quiet `vendor` event.
 */
export function projectScripted(raw: unknown): RuntimeEvent[] {
  const t = typeOf(raw)
  if (t === null) {
    return [unreadable('line')]
  }
  if (!isKnown(t)) {
    return [{ v: 1, thread: '', type: 'vendor', name: t }]
  }
  const parsed = conversationLines[t].safeParse(raw)
  if (!parsed.success) {
    return [unreadable(t)]
  }
  const handler = HANDLERS[parsed.data.t] as (line: ScriptedLine) => RuntimeEvent
  return [handler(parsed.data)]
}

/** A line as a session report: the runtime speaks only of the agent at work and its turns. */
export function scriptedReport(raw: unknown): SessionMessage {
  const events = projectScripted(raw)
  return {
    type: 'message',
    raw,
    events,
    work: true,
    byAgent: events.some((event) => event.thread === '' && isAgentOutput(event)),
    delivered: eventsOf(events, 'turn.ended').flatMap((end) => end.answered),
  }
}
