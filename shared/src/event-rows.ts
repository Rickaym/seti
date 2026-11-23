import type { RuntimeEvent } from './events.js'
import type { TurnBlock } from './prose-question.js'
import { projectClaude } from './runtimes/claude/project.js'
import type { MessageRow } from './tasks.js'

const NONE: readonly RuntimeEvent[] = []
const cache = new WeakMap<object, readonly RuntimeEvent[]>()

/** The neutral events of a stored runtime row, cached per payload; Seti's own rows have none. */
export function rowEvents(row: MessageRow): readonly RuntimeEvent[] {
  if (row.kind !== 'sdk') {
    return NONE
  }
  const cached = cache.get(row.payload)
  if (cached !== undefined) {
    return cached
  }
  const events = projectClaude(row.payload)
  cache.set(row.payload, events)
  return events
}

/** The neutral events of a runtime message stored as JSON text; text that does not parse has none. */
export function payloadEvents(payload: string): readonly RuntimeEvent[] {
  try {
    return projectClaude(JSON.parse(payload) as Parameters<typeof projectClaude>[0])
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
export function toolEnds(rows: readonly MessageRow[]): Map<string, EventOf<'tool.ended'>> {
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
