import type { RuntimeEvent } from './events.js'
import type { TurnBlock } from './prose-question.js'
import { projectClaude } from './runtimes/claude/project.js'
import { projectCodex } from './runtimes/codex/project.js'
import { projectRuntime, storedRuntime } from './runtimes/stored.js'
import type { MessageBase, MessagePage, MessageRow } from './tasks.js'

/** A runtime message as a client that asked for events gets it, cut as `trimmed` names. */
type EventsRow = MessageBase & { kind: 'events'; payload: readonly RuntimeEvent[] }

/** A message as a client gets it; a server older than events sends runtime rows as stored. */
export type WireRow = MessageRow | EventsRow

export interface WirePage extends Omit<MessagePage, 'messages'> {
  messages: WireRow[]
}

/** A row a runtime wrote, as stored or as its events, as opposed to one of Seti's own. */
export type RuntimeRow = Extract<WireRow, { kind: 'sdk' | 'events' }>

export const isRuntimeRow = (row: WireRow): row is RuntimeRow => row.kind === 'sdk' || row.kind === 'events'

/** A message, row or body, that Claude Code wrote, as stored. */
export const isClaudeRow = <R extends { kind: string; runtime?: unknown }>(
  row: R,
): row is Extract<R, { kind: 'sdk'; runtime?: undefined }> => row.kind === 'sdk' && row.runtime === undefined

/** A row as a client that asks for events gets it: a runtime row as its events. */
export function asEventsRow(row: WireRow): WireRow {
  if (row.kind !== 'sdk') {
    return row
  }
  const { id, task_id, outward, created_at, trimmed } = row
  const base =
    trimmed === undefined ? { id, task_id, outward, created_at } : { id, task_id, outward, created_at, trimmed }
  return { ...base, kind: 'events', payload: rowEvents(row) }
}

const NONE: readonly RuntimeEvent[] = []
const cache = new WeakMap<object, readonly RuntimeEvent[]>()

/** A runtime row's neutral events, projected once per stored payload; Seti's own rows have none. */
export function rowEvents(row: WireRow): readonly RuntimeEvent[] {
  if (row.kind === 'events') {
    return row.payload
  }
  if (row.kind !== 'sdk') {
    return NONE
  }
  const cached = cache.get(row.payload)
  if (cached !== undefined) {
    return cached
  }
  const events = row.runtime === 'codex' ? projectCodex(row.payload) : projectClaude(row.payload)
  cache.set(row.payload, events)
  return events
}

/**
 * The neutral events of a runtime message stored as JSON text, read as the row's `runtime` column
 * names its runtime; text that does not parse has none.
 */
export function payloadEvents(payload: string, runtime: string | null): readonly RuntimeEvent[] {
  try {
    return projectRuntime(storedRuntime(runtime), JSON.parse(payload) as unknown)
  } catch {
    return NONE
  }
}

/** The event of one type. */
export type EventOf<T extends RuntimeEvent['type']> = Extract<RuntimeEvent, { type: T }>

/** The events of one type, in order. */
export const eventsOf = <T extends RuntimeEvent['type']>(events: readonly RuntimeEvent[], type: T): EventOf<T>[] =>
  events.filter((event): event is EventOf<T> => event.type === type)

/** Whether an event is the agent's output: its text, its reasoning or a tool call it made. */
export const isAgentOutput = (event: RuntimeEvent): boolean =>
  (event.type === 'message' && event.role === 'agent') || event.type === 'reasoning' || event.type === 'tool.started'

/** The text the agent itself wrote in these events, one entry per message, blank ones included. */
export const agentTexts = (events: readonly RuntimeEvent[]): string[] =>
  eventsOf(events, 'message').flatMap((event) => (event.thread === '' && event.role === 'agent' ? [event.text] : []))

/** Each call's end in these rows by call id; a later end of the same call wins. */
export function toolEnds(rows: readonly WireRow[]): Map<string, EventOf<'tool.ended'>> {
  const ends = new Map<string, EventOf<'tool.ended'>>()
  for (const event of rows.flatMap((row) => eventsOf(rowEvents(row), 'tool.ended'))) {
    ends.set(event.callId, event)
  }
  return ends
}

/** The text when it holds more than white space, else null. */
export const nonBlank = (value: string | undefined): string | null =>
  value === undefined || value.trim() === '' ? null : value

/** The blocks a closing question is read from: what the agent wrote and the calls it made. */
export const turnBlocksOf = (events: readonly RuntimeEvent[]): TurnBlock[] =>
  events.flatMap((event): TurnBlock[] => {
    if (event.type === 'message' && event.role === 'agent') {
      return [{ type: 'text', text: event.text }]
    }
    return event.type === 'tool.started' ? [{ type: 'tool_use', name: event.call.name }] : []
  })
