import { z } from 'zod'

/**
 * How much an event deserves the user's attention: passive only informs the EA, digest waits for
 * the next brief, active is worth a notice, and urgent cannot wait. Needs-you is always urgent.
 */
export const ATTENTION_TIERS = ['urgent', 'active', 'digest', 'passive'] as const
export type AttentionTier = (typeof ATTENTION_TIERS)[number]

/**
 * Where the user wants a tier to reach them. push: a phone push while away, a toast while a page
 * has focus, the call while one is live. toast: only a page with focus, else the brief. brief:
 * only the brief on return. off: the EA knows, nothing shows.
 */
export const TIER_SURFACES = ['push', 'toast', 'brief', 'off'] as const
export type TierSurface = (typeof TIER_SURFACES)[number]

/** Urgent events always reach the user, so they cannot wait for the brief or stay silent. */
export const URGENT_SURFACES = ['push', 'toast'] as const satisfies readonly TierSurface[]
export type UrgentSurface = (typeof URGENT_SURFACES)[number]

/** The surface each tier uses; the user changes them in Settings, Notifications. */
export interface AttentionTiers {
  urgent: UrgentSurface
  active: TierSurface
  digest: TierSurface
  passive: TierSurface
}

export const DEFAULT_TIERS: AttentionTiers = { urgent: 'push', active: 'push', digest: 'brief', passive: 'off' }

export const attentionTiersInput = z.object({
  urgent: z.enum(URGENT_SURFACES).optional(),
  active: z.enum(TIER_SURFACES).optional(),
  digest: z.enum(TIER_SURFACES).optional(),
  passive: z.enum(TIER_SURFACES).optional(),
})

/** Whether a page with focus raises a toast for the tier. */
export const tierToasts = (tiers: AttentionTiers, tier: AttentionTier): boolean =>
  tiers[tier] === 'push' || tiers[tier] === 'toast'

/** What carried one event: exactly one of these, decided by `server/src/ea-attention.ts`. */
export const ATTENTION_ROUTES = ['push', 'toast', 'call', 'digest', 'passive'] as const
export type AttentionRoute = (typeof ATTENTION_ROUTES)[number]

/** No page with focus and no live EA call for this long means the user is away. */
export const AWAY_MS = 5 * 60 * 1000

/** One line of the brief, in the agent's or the notice's own words. */
export interface AttentionBriefLine {
  /** The agent the line is about; null for an EA item such as a channel alert. */
  task_id: string | null
  title: string
  text: string
  /** Where a tap opens Seti: the agent, or the EA chat. */
  url: string
}

/** What happened while the user was away, built once when they come back. */
export interface AttentionBrief {
  id: string
  /** When the user left. */
  since: string
  at: string
  /** Agents that wait on the user now, first. */
  needs_you: AttentionBriefLine[]
  /** One line per agent or EA item that changed while the user was away. */
  changed: AttentionBriefLine[]
  /** Lines left out to keep the brief short. */
  more: number
  /** The brief in one sentence, as the EA says it on a call. */
  summary: string
}

/** What every page reads: the brief waiting for the user, and the agents the EA reports on. */
export interface AttentionState {
  brief: AttentionBrief | null
  /** Agents the EA watches or waits for; its inbox carries their news, not the agent toasts. */
  ea_tasks: string[]
  /** How long without a focused page or a call counts as away, AWAY_MS unless tests shorten it. */
  away_ms: number
}

export const attentionBriefSeenInput = z.object({ id: z.string().min(1).max(64) })
export type AttentionBriefSeenInput = z.input<typeof attentionBriefSeenInput>
