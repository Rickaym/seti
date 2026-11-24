import type { RuntimeEvent, ToolCall } from '@seti/shared'

/** What transcript search indexes of one row: all its visible text, and the conversation alone. */
export interface SearchTexts {
  body: string
  talk: string | null
}

const BODY_CHARS = 12_000
const TEXT_CHARS = 8000
const CALL_CHARS = 300
const RESULT_CHARS = 2000
const LONG_WORD = /\S{200,}/g
const SPACES = /\s+/g

/** A part as the search index keeps it: cut, long unbroken runs dropped, white space folded. */
function part(value: string | undefined, cap: number): string | null {
  const folded = (value ?? '').slice(0, cap).replace(LONG_WORD, ' ').replace(SPACES, ' ').trim()
  return folded === '' ? null : folded
}

/** The words a call is found by: its name and what it acts on. */
function callText(call: ToolCall): string {
  const target =
    call.shell?.command ??
    call.edit?.changes.map((change) => change.path).join(' ') ??
    call.read?.paths.join(' ') ??
    call.search?.pattern ??
    call.shell?.description ??
    call.web?.url ??
    call.web?.query ??
    JSON.stringify(call.input)
  return [call.name, part(target, CALL_CHARS)].filter((text) => text !== null).join(' ')
}

function eventText(event: RuntimeEvent): string | null {
  if (event.type === 'message') {
    return event.role === 'agent' ? part(event.text, TEXT_CHARS) : null
  }
  if (event.type === 'tool.started') {
    return callText(event.call)
  }
  return event.type === 'tool.ended' ? part(event.result.text, RESULT_CHARS) : null
}

const joined = (texts: readonly (string | null)[]): string | null => {
  const kept = texts.filter((text) => text !== null)
  return kept.length === 0 ? null : kept.join(' ').slice(0, BODY_CHARS)
}

/**
 * The search texts of a runtime row from its neutral events, as the index keeps Claude Code's
 * from its JSON: the agent's own text, its calls and their output; subagent rows have none.
 */
export function searchTexts(events: readonly RuntimeEvent[]): SearchTexts | null {
  const own = events.filter((event) => event.thread === '')
  const body = joined(own.map(eventText))
  if (body === null) {
    return null
  }
  const talk = joined(own.map((event) => (event.type === 'message' ? eventText(event) : null)))
  return { body, talk }
}
