import { closingQuestion, type MessageRow, type ProseQuestion, type TurnBlock } from '@seti/shared'

/** What the agent's last turn ended by asking, read from the rows after the last prompt. */
export function askedInRows(rows: readonly MessageRow[]): ProseQuestion {
  const turn = rows.slice(rows.findLastIndex((row) => row.kind === 'prompt') + 1)
  const blocks = turn.flatMap((row): TurnBlock[] =>
    row.kind === 'sdk' && row.payload.type === 'assistant' && row.payload.parent_tool_use_id === null
      ? row.payload.message.content.map((block) => ({
          type: block.type,
          text: block.type === 'text' ? block.text : undefined,
        }))
      : [],
  )
  return closingQuestion(blocks)
}
