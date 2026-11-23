import { type MessageRow, agentTexts, eventsOf, rowEvents } from '@seti/shared'
import { messages } from './db.js'
import { redactSecrets } from './scrub.js'

const LINE_CHARS = 120
/** Enough of the transcript's tail to reach a turn's result and the text before its tool calls. */
const TURN_SCAN = 40

/** The first line of text with markdown markers trimmed and credentials redacted, kept short. */
export function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((part) =>
        part
          .replace(/^[\s#>*-]+/, '')
          .replaceAll('**', '')
          .trim(),
      )
      .find((part) => part !== '') ?? ''
  const clean = redactSecrets(line)
  return clean.length <= LINE_CHARS ? clean : `${clean.slice(0, LINE_CHARS - 3)}...`
}

/** The text the turn's last result reports, or '' without one. */
function resultText(turn: readonly MessageRow[]): string {
  const ends = turn.flatMap((row) => eventsOf(rowEvents(row), 'turn.ended'))
  return ends.at(-1)?.result ?? ''
}

/** The text the agent itself wrote during the turn, oldest first. */
const spokenTexts = (turn: readonly MessageRow[]): string[] => turn.flatMap((row) => agentTexts(rowEvents(row)))

/**
 * The first line of what the turn since the last prompt ended with: its result, else the last
 * text the agent wrote; null when it wrote nothing.
 */
function closingLineOf(rows: readonly MessageRow[]): string | null {
  const turn = rows.slice(rows.findLastIndex((row) => row.kind === 'prompt') + 1)
  const said = [resultText(turn), ...spokenTexts(turn).toReversed()].map(firstLine).find((line) => line !== '')
  return said ?? null
}

/** The closing line of the task's latest turn, read from the tail of its transcript. */
export async function closingLine(taskId: string): Promise<string | null> {
  return closingLineOf((await messages.page(taskId, TURN_SCAN)).messages)
}
