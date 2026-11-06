import { z } from 'zod'

/** text: the query anywhere in a message, like a browser's find; words: every word, any order. */
export const SEARCH_MODES = ['text', 'words'] as const
export type SearchMode = (typeof SEARCH_MODES)[number]

export const SEARCH_QUERY_MIN = 2
export const SEARCH_QUERY_MAX = 200
const SEARCH_PAGE = 100
const SEARCH_PAGE_MAX = 200

/** Trims the query and folds each run of whitespace into one space, as the index stores text. */
export const normalizeSearchQuery = (q: string): string => q.normalize('NFC').replace(/\s+/gu, ' ').trim()

export const chatSearchQuery = z.object({
  q: z
    .string()
    .transform(normalizeSearchQuery)
    .pipe(
      z
        .string()
        .min(SEARCH_QUERY_MIN, `Search for at least ${String(SEARCH_QUERY_MIN)} characters`)
        .max(SEARCH_QUERY_MAX),
    ),
  mode: z.enum(SEARCH_MODES).default('text'),
  /** Only matches older than this message id, for the next page. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_PAGE_MAX).default(SEARCH_PAGE),
  /** An agent's tool calls and output, shell runs and Seti's notes too; by default only messages. */
  tools: z.stringbool().default(false),
})
export type ChatSearchQuery = z.input<typeof chatSearchQuery>

/** A message that matched: where it is, and a short stretch of its text around the match. */
export interface SearchHit {
  id: number
  kind: string
  created_at: string
  snippet: string
}

export interface SearchResult {
  /** Newest first. */
  hits: SearchHit[]
  /** Matches older than the last hit exist; ask again with `before` set to its id. */
  has_more: boolean
  /** Matches from `before` on, counted up to the page size; `has_more` means there are more. */
  total: number
}
