/** The running total Claude Code last reported for the session a task's cost follows. */
export interface SessionTotal {
  session_id: string
  total_usd: number
}

export interface CountedResult {
  /** What the result's turn adds to the task's cost; null when it cannot be told. */
  cost: number | null
  /** The running total the next result of the task is counted against. */
  last: SessionTotal | null
}

/**
 * Counts one result by how much the session's running total grew, which a resumed process
 * carries on from. A lower total means Claude Code restored an older one or started over: that
 * turn's cost is unknown and later ones count from it. A failed start's zeroed total is skipped.
 */
export function countResult(last: SessionTotal | null, sessionId: string, total: number): CountedResult {
  if (!Number.isFinite(total) || total <= 0) {
    return { cost: null, last }
  }
  const previous = last?.session_id === sessionId ? last.total_usd : 0
  const next = { session_id: sessionId, total_usd: total }
  return { cost: total >= previous ? total - previous : null, last: next }
}
