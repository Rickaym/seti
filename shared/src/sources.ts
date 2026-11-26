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
