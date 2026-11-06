import type { MessagePage, MessageRow } from '@seti/shared'

export interface LoadedRows {
  messages: readonly MessageRow[]
  hasOlder: boolean
}

/** Transcripts cached this session; the least recently opened is dropped first. */
const LIMIT = 12

/** Rows a transcript showed, and the id of the last stream event they include, to resume after. */
interface CachedTranscript {
  rows: LoadedRows
  cursor: string | null
}

const cache = new Map<string, CachedTranscript>()

/** The rows an agent's transcript last showed in this session, to show again at once. */
export const cachedTranscript = (taskId: string): CachedTranscript | undefined => cache.get(taskId)

export function cacheTranscript(taskId: string, rows: LoadedRows, cursor: string | null): void {
  cache.delete(taskId)
  cache.set(taskId, { rows, cursor })
  for (const oldest of cache.keys()) {
    if (cache.size <= LIMIT) {
      break
    }
    cache.delete(oldest)
  }
}

/** Takes a fresh newest page, keeping older shown rows only when the page reaches them. */
export function withBacklog(shown: LoadedRows, page: MessagePage): LoadedRows {
  const first = page.messages[0]
  const shownLast = shown.messages.at(-1)
  if (first === undefined || shownLast === undefined || first.id > shownLast.id) {
    return { messages: page.messages, hasOlder: page.has_older }
  }
  const older = shown.messages.filter((row) => row.id < first.id)
  return older.length === 0
    ? { messages: page.messages, hasOlder: page.has_older }
    : { messages: [...older, ...page.messages], hasOlder: shown.hasOlder }
}
