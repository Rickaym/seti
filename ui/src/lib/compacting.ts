import { eventsOf, rowEvents, type WireRow, type RuntimeEvent } from '@seti/shared'

const COMPACT_COMMAND = /^\/compact(\s|$)/

type Step = 'command' | 'compacting' | 'end' | null

/** What a row says about compaction; queued prompts and unrelated rows say nothing. */
function compactStep(row: WireRow): Step {
  if (row.kind === 'prompt') {
    if (row.payload.queued !== undefined) {
      return null
    }
    return COMPACT_COMMAND.test(row.payload.text.trim()) ? 'command' : 'end'
  }
  if (row.kind === 'seti') {
    return 'end'
  }
  return rowEvents(row).reduce<Step>((step, event) => eventStep(event) ?? step, null)
}

/** What one runtime event says about compaction: a start, an end, or nothing. */
function eventStep(event: RuntimeEvent): Step {
  if (event.type === 'turn.ended') {
    return 'end'
  }
  if (event.type !== 'compaction') {
    return null
  }
  return event.phase === 'started' ? 'compacting' : 'end'
}

/** When the running turn's compaction began (its /compact or first status), else null. */
export function compactingSince(rows: readonly WireRow[], running: boolean): string | null {
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

/** Why a compaction failed, on the row that reports it; null for every other row. */
export function compactFailure(row: WireRow): string | null {
  const failed = eventsOf(rowEvents(row), 'compaction').find((event) => event.phase === 'failed')
  return failed === undefined ? null : (failed.error ?? 'no reason given')
}
