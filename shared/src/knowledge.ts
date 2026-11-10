import { z } from 'zod'

/** What a note teaches: a recipe, a fact, a trap to avoid, or how a machine or service is set up. */
export const KNOWLEDGE_KINDS = ['how-to', 'fact', 'gotcha', 'environment'] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

/** Only approved notes reach agents; stale ones wait to be verified or approved again. */
export const KNOWLEDGE_STATUSES = ['proposed', 'approved', 'rejected', 'stale'] as const
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number]

/** Who filed a note: an agent with propose_knowledge, the EA, or the user. */
export const KNOWLEDGE_PROPOSERS = ['agent', 'ea', 'user'] as const
export type KnowledgeProposer = (typeof KNOWLEDGE_PROPOSERS)[number]

export const KNOWLEDGE_SOURCE_KINDS = ['path', 'url', 'command'] as const
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number]

export const KNOWLEDGE_TITLE_MAX = 120
export const KNOWLEDGE_BODY_MAX = 4000
export const KNOWLEDGE_VERIFY_MAX = 300
export const KNOWLEDGE_SOURCE_MAX = 300
export const KNOWLEDGE_SOURCES_MAX = 5
export const KNOWLEDGE_NOTE_MAX = 500

/** Consecutive failed checks that take a note out of the index and file a correction. */
export const KNOWLEDGE_FAILURES_TO_STALE = 3

/** The most characters the index of approved note titles takes in an agent's system prompt. */
export const KNOWLEDGE_INDEX_MAX = 1500

/** Days a note stays fresh after its last passed check: facts and environments change sooner. */
export const KNOWLEDGE_FRESH_DAYS: Record<KnowledgeKind, number> = {
  fact: 30,
  environment: 30,
  'how-to': 90,
  gotcha: 90,
}

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/[\r\n]/.test(text), 'must be one line')

export const knowledgeSource = z.object({
  kind: z.enum(KNOWLEDGE_SOURCE_KINDS),
  ref: line(KNOWLEDGE_SOURCE_MAX),
})
export type KnowledgeSource = z.infer<typeof knowledgeSource>

/** The fields of a note, as an agent proposes it or the user edits it. */
export const knowledgeFields = z.object({
  kind: z.enum(KNOWLEDGE_KINDS),
  title: line(KNOWLEDGE_TITLE_MAX),
  body: z.string().trim().min(1).max(KNOWLEDGE_BODY_MAX),
  verify: line(KNOWLEDGE_VERIFY_MAX),
  sources: z.array(knowledgeSource).max(KNOWLEDGE_SOURCES_MAX).default([]),
  repo_id: z.uuid().nullable().default(null),
})
export type KnowledgeFields = z.output<typeof knowledgeFields>
export type KnowledgeFieldsInput = z.input<typeof knowledgeFields>

/** Approve as proposed, or with the user's edits applied first. */
export const approveKnowledgeInput = z.object({ edit: knowledgeFields.optional() }).strict()
export type ApproveKnowledgeInput = z.input<typeof approveKnowledgeInput>
export type ApproveKnowledge = z.output<typeof approveKnowledgeInput>

export const rejectKnowledgeInput = z.object({ reason: z.string().trim().max(KNOWLEDGE_NOTE_MAX).optional() }).strict()

/** One check of a note's verify step, passed or failed, with what the agent ran and saw. */
export const verifyKnowledgeInput = z.object({
  passed: z.boolean(),
  note: z.string().trim().min(1).max(KNOWLEDGE_NOTE_MAX),
})
export type VerifyKnowledgeInput = z.infer<typeof verifyKnowledgeInput>

export const knowledgeParams = z.object({ id: z.uuid() })

export const knowledgeListQuery = z.object({ status: z.enum(KNOWLEDGE_STATUSES).default('proposed') })

export const knowledgeSearchQuery = z.object({
  q: z.string().trim().max(200).default(''),
  repo_id: z.uuid().optional(),
})

export interface KnowledgeNote extends KnowledgeFields {
  id: string
  repo_slug: string | null
  status: KnowledgeStatus
  proposer: KnowledgeProposer
  proposer_task_id: string | null
  /** The proposing agent's title when it proposed, kept after the agent is gone. */
  proposer_title: string | null
  /** The approved note this one corrects, filed after its checks kept failing. */
  corrects_id: string | null
  /** Failed checks since the last passed one. */
  failures: number
  verified_count: number
  last_verified_at: string | null
  decided_at: string | null
  /** Why the note is stale or rejected, in words the user reads. */
  status_reason: string | null
  created_at: string
  updated_at: string
}

/** What waits for the user, for the badge on the Knowledge page. */
export interface KnowledgeSummary {
  proposed: number
  stale: number
}

/** The day after which a note last checked at `checkedAt` counts as stale. */
export function staleAfter(kind: KnowledgeKind, checkedAt: string): string {
  return new Date(Date.parse(checkedAt) + KNOWLEDGE_FRESH_DAYS[kind] * 86_400_000).toISOString()
}

export const KNOWLEDGE_KIND_LABELS: Record<KnowledgeKind, string> = {
  'how-to': 'How-to',
  fact: 'Fact',
  gotcha: 'Gotcha',
  environment: 'Environment',
}
