import type { CodexMessage } from '@seti/shared'
import { trimStrings, type Wire } from '../../wire-text.js'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The item a notification is about, whose call loses text when the message is cut. */
function itemIds(message: unknown): string[] {
  const params = isRecord(message) ? message.params : undefined
  const item = isRecord(params) ? params.item : undefined
  const id = isRecord(item) ? item.id : undefined
  return typeof id === 'string' ? [id] : []
}

/** A Codex message as the browser gets it: every long text cut, and the call that lost text named. */
export function wireCodex(payload: CodexMessage): Wire<CodexMessage> {
  const message = trimStrings(payload.message)
  return message === payload.message
    ? { value: payload, cut: [] }
    : { value: { ...payload, message }, cut: itemIds(payload.message) }
}
