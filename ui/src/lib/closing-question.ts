import { closingQuestion, rowEvents, turnBlocksOf, type WireRow, type ProseQuestion } from '@seti/shared'

/** What the agent's last turn ended by asking, read from the rows after the last prompt. */
export function askedInRows(rows: readonly WireRow[]): ProseQuestion {
  const turn = rows.slice(rows.findLastIndex((row) => row.kind === 'prompt') + 1)
  return closingQuestion(turnBlocksOf(turn.flatMap((row) => rowEvents(row)).filter((event) => event.thread === '')))
}
