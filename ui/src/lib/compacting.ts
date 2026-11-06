import type { MessageRow } from '@seti/shared'

const COMPACT_COMMAND = /^\/compact(\s|$)/

type Step = 'command' | 'compacting' | 'end' | null

/** What a row says about compaction; queued prompts and unrelated rows say nothing. */
function compactStep(row: MessageRow): Step {
  if (row.kind === 'prompt') {
    if (row.payload.queued !== undefined) {
      return null
    }
    return COMPACT_COMMAND.test(row.payload.text.trim()) ? 'command' : 'end'
  }
  if (row.kind === 'seti') {
    return 'end'
  }
  if (row.kind !== 'sdk') {
    return null
  }
  const { payload } = row
  if (payload.type === 'result') {
    return 'end'
  }
  if (payload.type !== 'system') {
    return null
  }
  if (payload.subtype === 'status') {
    return payload.status === 'compacting' ? 'compacting' : 'end'
  }
  return payload.subtype === 'compact_boundary' ? 'end' : null
}

/** When the running turn's compaction began (its /compact or first status), else null. */
export function compactingSince(rows: readonly MessageRow[], running: boolean): string | null {
  if (!running) {
    return null
  }
  let since: string | null = null
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    const step = row === undefined ? 'end' : compactStep(row)
    if (step === 'end' || row === undefined) {
      return since
    }
    if (step !== null) {
      since = row.created_at
      if (step === 'command') {
        return since
      }
    }
  }
  return since
}

/** Why a compaction failed, on the status row that reports it; null for every other row. */
export function compactFailure(row: MessageRow): string | null {
  if (row.kind !== 'sdk' || row.payload.type !== 'system' || row.payload.subtype !== 'status') {
    return null
  }
  const { compact_result: result, compact_error: error } = row.payload
  return result === 'failed' ? (error ?? 'no reason given') : null
}
