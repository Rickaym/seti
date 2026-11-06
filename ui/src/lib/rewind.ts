import type { MessageRow, TaskRewind } from '@seti/shared'

/** A transcript entry: a message, the messages one rewind folded away, or a note about a rewind. */
export type TranscriptItem =
  | { type: 'row'; row: MessageRow }
  | { type: 'rewound'; rewind: TaskRewind; rows: MessageRow[]; count: number }
  | { type: 'note'; rewind: TaskRewind }

/** Conversation rewinds fold their rows; code-only and refused ones leave a note instead. */
const folds = (rewind: TaskRewind) => rewind.restore !== 'code' && rewind.state !== 'refused'

/** The earliest-starting folding rewind that covers a row, so nested rewinds fold into one group. */
function cover(rewinds: readonly TaskRewind[], id: number): TaskRewind | undefined {
  let found: TaskRewind | undefined
  for (const rewind of rewinds) {
    if (id >= rewind.prompt_message_id && id <= rewind.last_message_id) {
      if (found === undefined || rewind.prompt_message_id < found.prompt_message_id) {
        found = rewind
      }
    }
  }
  return found
}

/** Messages a group drops: its own count plus those of the rewinds folded inside it. */
const groupCount = (outer: TaskRewind, folding: readonly TaskRewind[]) =>
  folding
    .filter((r) => r.prompt_message_id >= outer.prompt_message_id && r.prompt_message_id <= outer.last_message_id)
    .reduce((sum, r) => sum + r.message_count, 0)

export function transcriptItems(rows: readonly MessageRow[], rewinds: readonly TaskRewind[]): TranscriptItem[] {
  const folding = rewinds.filter(folds)
  const notes = rewinds.filter((rewind) => !folds(rewind))
  const items: TranscriptItem[] = []
  for (const row of rows) {
    const rewind = cover(folding, row.id)
    const last = items.at(-1)
    if (rewind === undefined) {
      items.push({ type: 'row', row })
    } else if (last?.type === 'rewound' && last.rewind.id === rewind.id) {
      last.rows.push(row)
    } else {
      items.push({ type: 'rewound', rewind, rows: [row], count: groupCount(rewind, folding) })
    }
    for (const note of notes) {
      if (note.last_message_id === row.id) {
        items.push({ type: 'note', rewind: note })
      }
    }
  }
  return items
}
