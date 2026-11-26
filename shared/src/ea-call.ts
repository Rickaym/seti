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

/** The kind of microphone a call used, from its name; the name never leaves the page. */
const EA_INPUT_KINDS = ['default', 'bluetooth', 'built-in', 'wired', 'usb', 'other'] as const
export type EaInputKind = (typeof EA_INPUT_KINDS)[number]

/** A call records at most this many microphone kinds, in the order it used them. */
export const EA_MAX_INPUTS = 8

const DAY_SECONDS = 24 * 60 * 60
const seconds = z.number().int().min(0).max(DAY_SECONDS).nullable()

const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'] as const
const PATH_PROTOCOLS = ['udp', 'tcp', 'tls'] as const
const MS = z.number().min(0).max(600_000)

/** How the EA's voice fared on the call, as numbers only: never audio, words or addresses. */
export const eaCallQuality = z.object({
  /** Share of the EA's voice packets the network lost, in percent. */
  lost_pct: z.number().min(0).max(100),
  /** Seconds of the EA's speech the phone had to fill in for audio that never came. */
  concealed_s: z.number().min(0).max(DAY_SECONDS),
  /** The jitter of the EA's voice packets on arrival. */
  jitter_ms: MS,
  /** The round trip on the network path at the end; null when the browser did not say. */
  rtt_ms: MS.nullable(),
  /** How the path ran: straight between the two ends (host, srflx, prflx) or through a relay. */
  path: z.enum(CANDIDATE_TYPES).nullable(),
  /** The protocol to the relay, or of the direct path. */
  protocol: z.enum(PATH_PROTOCOLS).nullable(),
  /** How often the call rebuilt its network path. */
  reconnects: z.number().int().min(0).max(1000),
})
export type EaCallQuality = z.infer<typeof eaCallQuality>

/** A call's quality in one line, such as "1.2% lost, 0.4 s filled in, relay over UDP". */
export function callQualityText(quality: EaCallQuality): string {
  const parts = [`${String(quality.lost_pct)}% lost`, `${String(quality.concealed_s)} s filled in`]
  if (quality.path !== null) {
    const route = quality.path === 'relay' ? 'relay' : 'direct'
    parts.push(quality.protocol === null ? route : `${route} over ${quality.protocol.toUpperCase()}`)
  }
  if (quality.reconnects > 0) {
    parts.push(`${String(quality.reconnects)} ${quality.reconnects === 1 ? 'reconnect' : 'reconnects'}`)
  }
  return parts.join(', ')
}

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
  /** The kinds of microphone the call used, in order; empty from pages that predate it. */
  inputs: z.array(z.enum(EA_INPUT_KINDS)).max(EA_MAX_INPUTS).default([]),
  /** How often the call reopened the microphone for a headset; null when the page did not say. */
  reroutes: z.number().int().min(0).max(10_000).nullable().default(null),
  /** How the EA's voice fared; null when the call never sampled it or the page predates it. */
  quality: eaCallQuality.nullable().default(null),
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
