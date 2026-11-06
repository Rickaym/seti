import { RESENT_NOTE, type MessageRow } from '@seti/shared'

export type SetiPayload = Extract<MessageRow, { kind: 'seti' }>['payload']

export const isFailureNote = ({ memory, session, stopped, seti_control: control, bypass, error }: SetiPayload) =>
  memory === undefined &&
  session === undefined &&
  stopped !== true &&
  control === undefined &&
  bypass === undefined &&
  error !== RESENT_NOTE

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
