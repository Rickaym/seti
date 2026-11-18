import { RESENT_NOTE, type MessageRow } from '@seti/shared'

export type SetiPayload = Extract<MessageRow, { kind: 'seti' }>['payload']

export const isFailureNote = (note: SetiPayload) =>
  note.memory === undefined &&
  note.session === undefined &&
  note.stopped !== true &&
  note.seti_control === undefined &&
  note.bypass === undefined &&
  note.timed_out === undefined &&
  note.error !== RESENT_NOTE

/** The failed turn no message has followed yet, which the notice under the transcript shows. */
export function openFailure(messages: readonly MessageRow[]): number | null {
  for (const row of messages.toReversed()) {
    if (row.kind === 'prompt') {
      return null
    }
    if (row.kind === 'seti' && isFailureNote(row.payload)) {
      return row.id
    }
  }
  return null
}
