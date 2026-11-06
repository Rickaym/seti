import { z } from 'zod'

/** How long the user has to answer a question the EA asked before a tool acts; the EA's own gate. */
export const EA_ASK_TTL_MS = 10 * 60 * 1000

/**
 * Where a question the EA asked stands: waiting for the user, past its time, answered and waiting
 * for the EA to take it, or acted on.
 */
export type EaAskState = 'pending' | 'expired' | 'allowed' | 'denied' | 'done' | 'failed'

export const EA_ASK_DECISIONS = ['allow', 'deny'] as const
export type EaAskDecision = (typeof EA_ASK_DECISIONS)[number]

/** A tool call the EA holds back until the user allows it, as a notification shows it. */
export interface EaAsk {
  id: number
  tool: string
  /** What the tool would do, such as `delete agent Voicemail retry`. */
  summary: string
  state: EaAskState
  /** What came of it once the EA acted, such as the error. */
  detail: string | null
  expires_at: string
}

/** One EA message the user has not seen: a reply, a report it wrote unasked, or an inbox notice. */
export interface EaUnseenReply {
  /** The EA history entry. */
  id: number
  text: string
  created_at: string
  /** The questions this reply puts to the user, oldest first. */
  asks: EaAsk[]
}

export interface EaUnseenReplies {
  /** The newest unseen messages, oldest first. */
  replies: EaUnseenReply[]
  /** Every unseen message, including those past the page. */
  total: number
}

const EA_SEEN_MAX = 100
const entryId = z.number().int().positive()

/** Marks EA messages seen: the ones named, or every one up to and including `through`. */
export const eaRepliesSeenInput = z
  .object({
    ids: z.array(entryId).min(1).max(EA_SEEN_MAX).optional(),
    through: entryId.optional(),
  })
  .refine((input) => input.ids !== undefined || input.through !== undefined, 'Name ids or through')
export type EaRepliesSeenInput = z.input<typeof eaRepliesSeenInput>

export interface EaRepliesSeen {
  seen: number
}

const ASK_ARGS_MAX = 32 * 1024

/** The EA process and the user turn within it, so a yes covers only questions asked before it. */
const askedIn = {
  epoch: z.string().min(1).max(64),
  turn: z.number().int().min(0),
}

/** A question the EA asked before a tool acts, with the exact call an Allow runs. */
export const eaAskInput = z.object({
  tool: z
    .string()
    .regex(/^[a-z][a-z_]{0,63}$/, 'A tool name is lower case letters and underscores')
    .max(64),
  args: z
    .record(z.string().max(64), z.unknown())
    .refine((args) => JSON.stringify(args).length <= ASK_ARGS_MAX, 'The arguments are too large'),
  summary: z.string().trim().min(1).max(300),
  /** The tool's own key for the exact change, so asking again reuses the open question. */
  key: z.string().min(1).max(4000),
  ...askedIn,
})
export type EaAskInput = z.input<typeof eaAskInput>
export type EaAskRecord = z.output<typeof eaAskInput>

export const eaAskParams = z.object({ id: z.coerce.number().int().positive() })

/** The user's answer to one question, from a notification's Allow or Deny. */
export const eaAskDecisionInput = z.object({ decision: z.enum(EA_ASK_DECISIONS) })
export type EaAskDecisionInput = z.input<typeof eaAskDecisionInput>

/**
 * The user's yes, typed or spoken, to questions the EA asked before this turn: by their ids, or
 * by the tool's key when the EA called the tool again with confirmed.
 */
export const eaAskConfirmInput = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(16).optional(),
    key: z.string().min(1).max(4000).optional(),
    ...askedIn,
  })
  .refine((input) => input.ids !== undefined || input.key !== undefined, 'Name ids or key')
export type EaAskConfirmInput = z.output<typeof eaAskConfirmInput>

/** What came of an allowed call, as the EA reports it. */
export const eaAskOutcomeInput = z.object({
  outcome: z.enum(['done', 'failed']),
  detail: z.string().max(500).default(''),
})
export type EaAskOutcomeInput = z.input<typeof eaAskOutcomeInput>
export type EaAskOutcome = z.output<typeof eaAskOutcomeInput>

/** An answered question the EA takes, with the call to run when the user allowed it. */
export interface EaAnsweredAsk {
  id: number
  tool: string
  args: Record<string, unknown>
  summary: string
  decision: EaAskDecision
}

/** A question still waiting for the user, as the EA lists them to itself. */
export interface EaOpenAsk {
  id: number
  tool: string
  summary: string
  created_at: string
}
