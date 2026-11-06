import { z } from 'zod'
import type { AttentionRoute } from './attention.js'
import type { EaHistoryEntry, EaInboxKind, EaNotice } from './ea.js'

/** How an item reached the user: spoken on a call, posted in the EA chat, or posted by Seti. */
export type EaInboxVia = 'voice' | 'chat' | 'seti'

/** Something for the EA: a follow-up or reminder when due, or an event from a watch or a channel. */
export interface EaInboxItem extends EaNotice {
  id: number
  task_id: string | null
  due_at: string
  created_at: string
  delivered_at: string | null
  delivered_via: EaInboxVia | null
  acknowledged_at: string | null
  cancelled_at: string | null
  /** The user's timezone when it was scheduled; null for events. */
  timezone: string | null
  /** Reaches a live call at the next safe moment, waking the EA; others wait for a pause. */
  urgent: boolean
  /** For a group chat mention, the message that mentioned the EA. */
  message_id: number | null
  /** A channel alert from a subscription in act mode: the EA may hand its work to an agent. */
  act: boolean
  /** The one surface that carried it once delivered; null before then. */
  route: AttentionRoute | null
}

/** Follow-ups the EA may chain from a follow-up, so one check cannot reschedule itself forever. */
export const EA_FOLLOWUP_MAX_DEPTH = 3

export const EA_FOLLOWUP_KINDS = ['followup', 'reminder'] as const satisfies readonly EaInboxKind[]

/**
 * A check-back the EA schedules for itself, or a reminder for the user. `when` is relative,
 * such as `in 20 minutes`, or a local time in `timezone`, such as `tomorrow at 9am`.
 */
export const eaFollowupInput = z.object({
  kind: z.enum(EA_FOLLOWUP_KINDS).default('followup'),
  when: z.string().trim().min(1).max(80),
  timezone: z.string().trim().min(1).max(64).optional(),
  note: z.string().trim().min(1).max(2000),
  task_id: z.string().trim().min(1).max(100).nullish(),
  /** The follow-up the EA was working on when it scheduled this one. */
  parent_id: z.number().int().positive().optional(),
})
export type EaFollowupInput = z.input<typeof eaFollowupInput>

export interface EaFollowup extends EaInboxItem {
  /** The due time as the user reads it, such as `Monday 15:00 (Europe/Berlin)`. */
  local_due: string
}

export const eaWatchInput = z.object({
  task_id: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).default(''),
  /** Only the end of the task's current or next turn, once, instead of a standing watch. */
  once: z.boolean().default(false),
})
export type EaWatchInput = z.input<typeof eaWatchInput>

/** A task whose turn ends, PR changes and waiting updates reach the EA inbox. */
export interface EaWatch {
  id: number
  task_id: string
  task_title: string
  note: string
  created_at: string
}

/**
 * Items the EA takes: voice once spoken at a pause, chat when posted in the EA chat. The items in
 * `notify` get no report of the EA's, so Seti raises the toast for those its router sends there.
 */
export const eaInboxDeliverInput = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
  via: z.enum(['voice', 'chat']),
  notify: z.array(z.number().int().positive()).max(100).default([]),
})

export interface EaInboxDelivered {
  /** The items this call delivered; any another caller took first are left out. */
  items: EaInboxItem[]
  /** The history entries that carry them, in the same order. */
  entries: EaHistoryEntry[]
}

export interface EaInboxUnread {
  /** Delivered to the chat and not yet seen there. */
  unread: number
  /** Due and waiting for the EA to take them. */
  waiting: number
}
