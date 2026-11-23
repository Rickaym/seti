import { isAgentOutput, payloadEvents, projectClaude, type MessageBody, type RuntimeEvent } from '@seti/shared'

/** The `task_message` columns a row's events fill. */
export const EVENT_COLUMNS = [
  'runtime',
  'thread',
  'event',
  'agent',
  'turn_usd',
  'turn_ms',
  'turn_steps',
  'turn_reply',
] as const

/** What `task_message` keeps of a row's events for SQL to filter on; see `MESSAGE_EVENTS`. */
export interface EventColumns {
  runtime: string
  thread: string
  event: string | null
  agent: boolean
  turn_usd: number | null
  turn_ms: number | null
  turn_steps: number | null
  turn_reply: boolean | null
}

const finite = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) ? value : null

/** The columns of a row a runtime wrote, from its events; Seti's own rows have none. */
function eventColumns(runtime: string, events: readonly RuntimeEvent[]): EventColumns {
  const [first] = events
  const end = events.find((event) => event.type === 'turn.ended')
  const steps = finite(end?.steps)
  return {
    runtime,
    thread: first?.thread ?? '',
    event: first?.type ?? null,
    agent: events.some(isAgentOutput),
    turn_usd: finite(end?.costUsd),
    turn_ms: finite(end?.durationMs),
    turn_steps: steps === null ? null : Math.round(steps),
    turn_reply: end === undefined ? null : end.result !== '',
  }
}

/** The columns of a message about to be stored. */
export const messageColumns = (body: MessageBody): EventColumns =>
  eventColumns('claude', body.kind === 'sdk' ? projectClaude(body.payload) : [])

/** The columns of a row stored as JSON text, as an archive or an import holds it. */
export const storedColumns = (kind: string, payload: string): EventColumns =>
  eventColumns('claude', kind === 'sdk' ? payloadEvents(payload) : [])
