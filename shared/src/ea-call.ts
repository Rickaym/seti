import { z } from 'zod'

/** Why a voice call ended, as the browser on the call saw it. */
const EA_CALL_END_REASONS = ['hang-up', 'server-closed', 'ice-failed', 'bot-error', 'bot-idle', 'page-closed'] as const
export type EaCallEndReason = (typeof EA_CALL_END_REASONS)[number]

/** How each reason reads in the settings and the audit log. */
export const EA_CALL_END_TEXT: Readonly<Record<EaCallEndReason, string>> = {
  'hang-up': 'Hung up',
  'server-closed': 'The EA closed the call',
  'ice-failed': 'The network path failed',
  'bot-error': 'An EA service failed',
  'bot-idle': 'The EA ended an idle call',
  'page-closed': 'Seti closed during the call',
}

const DAY_SECONDS = 24 * 60 * 60
const seconds = z.number().int().min(0).max(DAY_SECONDS).nullable()

/** A call end the browser reports for the audit log; it carries no audio and no words. */
export const eaCallEndInput = z.object({
  reason: z.enum(EA_CALL_END_REASONS),
  /** Seti joined the call on its own when it opened. */
  auto: z.boolean(),
  /** Whether the page was in the background when the call ended or was last seen. */
  hidden: z.boolean(),
  /** Seconds the call was connected; null when the page closed before it could say. */
  duration_s: seconds,
  /** Seconds the page had been in the background at the end; null when unknown or on screen. */
  hidden_s: seconds,
})
export type EaCallEndInput = z.input<typeof eaCallEndInput>

/** The RTVI server message the bot sends just before it ends a call on its own. */
export const eaCallEndMessage = z.object({
  type: z.literal('ea-call-end'),
  reason: z.literal('bot-idle'),
})

/** The audit summary of a call end, such as "EA call ended: Hung up, in the background". */
export function callEndSummary({ reason, hidden }: Pick<EaCallEndInput, 'reason' | 'hidden'>): string {
  return `EA call ended: ${EA_CALL_END_TEXT[reason]}${hidden ? ', in the background' : ''}`
}
