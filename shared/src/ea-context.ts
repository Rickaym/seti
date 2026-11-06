import { z } from 'zod'
import type { TaskDisplayStatus } from './tasks.js'

/** A task as the live context names it, so the EA can match what the user says to it. */
export interface EaContextTask {
  id: string
  title: string
  status: TaskDisplayStatus
}

/** What is going on in Seti now, as compact text for the EA's model, rebuilt as tasks change. */
export interface EaContext {
  text: string
  as_of: string
  /** A rough size of the text, at four characters per token. */
  tokens: number
  /** Every task the text covers, listed or counted. */
  tasks: EaContextTask[]
}

export const EA_SEARCH_MODES = ['hybrid', 'text'] as const
export type EaSearchMode = (typeof EA_SEARCH_MODES)[number]

const SEARCH_LIMIT_MAX = 20

/** hybrid: embeddings and full text; text: full text only, fast enough for every voice turn. */
export const eaSearchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  task: z.string().trim().min(1).max(100).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).default(6),
  mode: z.enum(EA_SEARCH_MODES).default('hybrid'),
  /** Leave out hits holding less than this share of the query's words, as for unasked searches. */
  min_match: z.coerce.number().min(0).max(1).optional(),
})
export type EaSearchQuery = z.input<typeof eaSearchQuery>

/** prompt: the user; agent: the agent's text; result: a turn's answer; pr_update: CI or a review. */
export type EaDocKind = 'prompt' | 'agent' | 'result' | 'subagent' | 'pr_update' | 'pr_body'

export interface EaSearchHit {
  kind: EaDocKind
  task_id: string | null
  task_title: string | null
  pr_url: string | null
  pr_title: string | null
  repo: string | null
  at: string
  snippet: string
  /** Relative to the other hits of the same search, 0 to 1. */
  score: number
  /** From an archived agent; such hits rank lower. */
  archived: boolean
}

export interface EaSearchResult {
  /** hybrid when embeddings took part; text when only full-text search did. */
  mode: EaSearchMode
  hits: EaSearchHit[]
}

export interface EaIndexStatus {
  documents: number
  embedded: number
  /** Whether the vector extension serves similarity search; without it search is full text only. */
  vector: boolean
  /** Whether Seti has a key to compute embeddings with. */
  embeddings: boolean
}
