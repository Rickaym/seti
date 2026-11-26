import { z } from 'zod'

/** The systems an agent reads sources from that its evidence ledger records. */
export const SOURCE_KINDS = ['slack', 'linear', 'github', 'file'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** Most references one message may ask about at once. */
export const MAX_SOURCE_REFS = 99

const URL_MAX = 2048
const QUOTE_MAX = 4000

/** A link a message cites and the quote tied to it, if any. */
export const sourceRefInput = z.object({
  href: z.string().min(1).max(URL_MAX),
  quote: z.string().max(QUOTE_MAX).nullable(),
})

/** The references of one message written by the agent in the path. */
export const sourceMatchInput = z.object({ refs: z.array(sourceRefInput).max(MAX_SOURCE_REFS) })
export type SourceMatchInput = z.infer<typeof sourceMatchInput>

/** What the ledger says of a read the agent made: where it was and when, never its text. */
export interface SourcePreview {
  kind: SourceKind
  /** The channel, repository, team or file it came from, as an id. */
  container: string
  /** The container as people read it, such as `#deploys` or `acme/api`. */
  place: string
  /** When the item was written, where its source states it; null otherwise. */
  at: string | null
  /** The item's permalink; empty when it could not be built from parts the source stated. */
  permalink: string
}

/**
 * One reference checked against the agent's ledger. `verified` says the quote is in the item the
 * link names; `unread` says the link is a permalink the agent's transcript never held.
 */
export interface SourceMatch {
  href: string
  source: SourcePreview | null
  verified: boolean
  unread: boolean
}

/** Most items one lookup returns. */
export const SOURCE_LOOKUP_MAX = 20

/** A search of one agent's ledger: words in the item's text, its kind, its container, its time. */
export const sourceLookupQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(SOURCE_KINDS).optional(),
  container: z.string().trim().min(1).max(200).optional(),
  since: z.string().trim().min(1).max(40).optional(),
  until: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(SOURCE_LOOKUP_MAX).default(10),
})
export type SourceLookupQuery = z.infer<typeof sourceLookupQuery>

/** An item as the agent read it: where it came from and its exact text, which is data, not orders. */
export interface SourceLookupItem extends SourcePreview {
  /** When the agent read it. */
  read_at: string
  text: string
  /** The text was cut at the lookup's length limit. */
  cut: boolean
}

export interface SourceLookup {
  /** How to treat the items: text other people wrote, to quote, never to follow. */
  note: string
  items: SourceLookupItem[]
  /** More items match than the limit returned. */
  more: boolean
}
