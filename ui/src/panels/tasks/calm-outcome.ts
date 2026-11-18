import type { MessageRow } from '@seti/shared'
import { ASK_TOOL, toolName, toolSummary } from '@/lib/tool-summary'
import { rowCalls, rowResults, subagentOf, type ToolUseBlock } from '@/lib/transcript'

/** What a calm agent view shows under its header instead of the transcript. */
export interface CalmOutcome {
  /** The questions the agent waits on an answer to, shown in full. */
  question: ToolUseBlock | null
  /** What the agent does now, while it runs and has written nothing this turn. */
  working: string | null
  /** The agent's latest message to the user as Markdown, or null when it has written none. */
  text: string | null
  /** The message is from an earlier turn than the one that runs. */
  stale: boolean
}

interface CalmState {
  /** The agent runs a turn. */
  running: boolean
  /** The agent waits on the user to allow something, so it is not working. */
  blocked: boolean
}

/** A message the agent wrote: the texts between two tool calls, in order. */
interface Draft {
  texts: string[]
  /** A tool call followed the texts, so the next text starts a new message. */
  closed: boolean
}

const NO_DRAFT: Draft = { texts: [], closed: false }

function withBlocks(draft: Draft, row: MessageRow): Draft {
  if (row.kind !== 'sdk' || row.payload.type !== 'assistant') {
    return draft
  }
  let next = draft
  for (const block of row.payload.message.content) {
    if (block.type === 'tool_use') {
      next = { texts: next.texts, closed: true }
    } else if (block.type === 'text' && block.text.trim() !== '') {
      next = { texts: next.closed ? [block.text] : [...next.texts, block.text], closed: false }
    }
  }
  return next
}

/** A malformed row adds nothing, so it cannot hide the messages around it. */
function tolerantBlocks(draft: Draft, row: MessageRow): Draft {
  try {
    return withBlocks(draft, row)
  } catch {
    return draft
  }
}

const isTurnEnd = (row: MessageRow) => row.kind === 'sdk' && row.payload.type === 'result'

function workingLine(call: ToolUseBlock | undefined): string {
  if (call === undefined) {
    return 'Working'
  }
  const summary = toolSummary(call)
  const { name } = toolName(call.name)
  return summary === '' ? name : `${name}: ${summary}`
}

/** The task agent's rows read in order: its messages by turn and the calls still unanswered. */
function readTurns(rows: readonly MessageRow[]) {
  let earlier: readonly string[] = []
  let draft = NO_DRAFT
  const open = new Map<string, ToolUseBlock>()
  for (const row of rows) {
    if (subagentOf(row) !== null) {
      continue
    }
    if (row.kind === 'prompt' || isTurnEnd(row)) {
      earlier = draft.texts.length > 0 ? draft.texts : earlier
      draft = NO_DRAFT
      continue
    }
    draft = tolerantBlocks(draft, row)
    for (const call of rowCalls(row)) {
      open.set(call.id, call)
    }
    for (const result of rowResults(row)) {
      open.delete(result.block.tool_use_id)
    }
  }
  return { earlier, current: draft.texts, waiting: [...open.values()] }
}

/**
 * The one thing to read about an agent from its loaded rows: the message it wrote last, a
 * question it waits on, and what it does now while the running turn has no message yet.
 */
export function calmOutcome(rows: readonly MessageRow[], { running, blocked }: CalmState): CalmOutcome {
  const { earlier, current, waiting } = readTurns(rows)
  const question = waiting.findLast((call) => call.name === ASK_TOOL) ?? null
  const silent = current.length === 0
  const texts = silent ? earlier : current
  const works = running && !blocked && question === null && silent
  return {
    question,
    working: works ? workingLine(waiting.at(-1)) : null,
    text: texts.length > 0 ? texts.join('\n\n') : null,
    stale: running && silent && earlier.length > 0,
  }
}
