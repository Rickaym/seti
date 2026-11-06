import { z } from 'zod'

/** Days of EA usage Seti keeps; older rows go as new ones arrive. */
export const EA_USAGE_KEEP_DAYS = 30

/** The rolling window the EA usage stats count, in days. */
export const EA_USAGE_WINDOW_DAYS = 7

/** Where an EA model call ran: on a voice call, in the typed chat, or as an inbox report. */
export const EA_USAGE_CHANNELS = ['voice', 'chat', 'inbox'] as const
export type EaUsageChannel = (typeof EA_USAGE_CHANNELS)[number]

const EA_USAGE_BATCH_MAX = 200
const TOKENS_MAX = 10_000_000
const LATENCY_MAX_MS = 10 * 60 * 1000

const tokens = z.number().int().min(0).max(TOKENS_MAX)
const latencyMs = z.number().int().min(0).max(LATENCY_MAX_MS)
/** A model or service name, such as `gpt-4.1` or `eleven_flash_v2_5`; never free text. */
const label = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\w.:/-]+$/)

/** One model call the EA made, in numbers and labels only. */
const eaModelCall = z.strictObject({
  kind: z.literal('llm'),
  channel: z.enum(EA_USAGE_CHANNELS),
  model: label,
  /** Time to first byte; null when the call ended before its first byte. */
  ttfb_ms: latencyMs.nullable(),
  /** Every input token, cached ones included. */
  prompt_tokens: tokens,
  cached_tokens: tokens,
  completion_tokens: tokens,
  tool_calls: z.number().int().min(0).max(128),
})

/** How long speech to text or text to speech took to answer on a call. */
const eaSpeechLatency = z.strictObject({
  kind: z.enum(['stt', 'tts']),
  channel: z.literal('voice'),
  model: label.nullable(),
  ttfb_ms: latencyMs,
})

const eaUsageRecord = z.discriminatedUnion('kind', [eaModelCall, eaSpeechLatency])
export type EaUsageRecord = z.infer<typeof eaUsageRecord>

/** What the EA bot reports in one batch. */
export const eaUsageInput = z.object({ records: z.array(eaUsageRecord).min(1).max(EA_USAGE_BATCH_MAX) })

export interface EaUsageRecorded {
  recorded: number
}

/** A median and a 95th percentile in milliseconds; null with no samples. */
export interface EaLatency {
  samples: number
  p50_ms: number | null
  p95_ms: number | null
}

/** What the EA's model calls cost and how fast they and its speech services answered. */
export interface EaUsageStats {
  /** The timezone today is counted in. */
  zone: string
  window_days: number
  calls_today: number
  calls_window: number
  /** Model calls in the window by where they ran. */
  by_channel: Record<EaUsageChannel, number>
  /** Time to first byte of the model calls in the window. */
  ttfb: EaLatency
  avg_prompt_tokens: number | null
  avg_completion_tokens: number | null
  /** The share of input tokens served from the prompt cache, from 0 to 1. */
  cached_share: number | null
  tool_calls: number
  /** The models used in the window, most calls first. */
  models: string[]
  stt: EaLatency
  tts: EaLatency
}
