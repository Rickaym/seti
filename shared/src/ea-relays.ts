import { z } from 'zod'
import type { TeamDeliveryMode } from './team.js'

/** The longest message the EA may relay; a relay is a gist and a next step, never a copy. */
export const EA_RELAY_TEXT_MAX = 400

/** A run of this many words copied from the item makes a relay a quote, which Seti refuses. */
export const EA_RELAY_COPY_WORDS = 8

/** Relays per agent and in all within one window, so untrusted items cannot flood agents. */
export const EA_RELAY_LIMITS = { perAgent: 2, all: 8, windowMs: 60 * 60_000 } as const

/** Assignments in all and new agents started from act items, per day. */
export const EA_ASSIGN_DAILY = { all: 20, starts: 3, windowMs: 24 * 60 * 60_000 } as const

/** The user's switch for Assign; only the user turns it on or off. */
export const eaRelaySwitchInput = z.object({ on: z.boolean() })

/**
 * The EA passes an inbox item to an agent in its own words: `to` names an existing agent, or
 * `start` starts a new one for an item from a channel the user set to act.
 */
export const eaRelayInput = z
  .object({
    item_id: z.number().int().positive(),
    /** The agent's task id or group chat handle. */
    to: z.string().trim().min(1).max(200).optional(),
    start: z.object({ title: z.string().trim().min(1).max(200).optional() }).optional(),
    text: z.string().trim().min(1).max(EA_RELAY_TEXT_MAX),
  })
  .refine((input) => (input.to === undefined) !== (input.start === undefined), {
    message: 'Name one agent with to, or start a new one with start',
  })
export type EaRelayInput = z.output<typeof eaRelayInput>

export const EA_ASSIGN_SKIP_KINDS = ['agent', 'channel'] as const

/** An agent or channel the user told the EA to stop assigning to or from. */
export const eaAssignSkipInput = z.object({
  kind: z.enum(EA_ASSIGN_SKIP_KINDS),
  /** The agent's task id or handle, or the channel's id or name. */
  ref: z.string().trim().min(1).max(200),
})
export type EaAssignSkipInput = z.output<typeof eaAssignSkipInput>

export interface EaAssignSkip {
  kind: (typeof EA_ASSIGN_SKIP_KINDS)[number]
  /** The task or channel id. */
  ref: string
  /** The agent's title or the channel's name as Seti knows it now. */
  name: string
  created_at: string
}

/** A relay the EA sent; Take back works while `pending`, before the agent has read it. */
export interface EaRelay {
  id: number
  item_id: number | null
  task_id: string | null
  /** The agent's title as it was when the relay went. */
  title: string
  message_id: number | null
  mode: TeamDeliveryMode
  pending: boolean
  taken_back: boolean
  /** The EA started this agent for the item rather than messaging one. */
  started: boolean
  created_at: string
}
