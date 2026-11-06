import { useEffect } from 'react'

/** Claude Code reports compaction every 30 seconds; this much silence means a stale view. */
const SILENT_MS = 5 * 60_000

/**
 * Refetches the agent once when compaction shows and no new row arrives for five minutes. A row
 * that arrives starts the wait again; a refetch that changes nothing does not repeat.
 */
export function useCompactingResync(compacting: string | null, newestRow: number | undefined, resync: () => void) {
  useEffect(() => {
    if (compacting === null) {
      return undefined
    }
    const timer = window.setTimeout(resync, SILENT_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [compacting, newestRow, resync])
}
