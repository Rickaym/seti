import { z } from 'zod'

/** Days of EA usage Seti keeps; older rows go as new ones arrive. */
export const EA_USAGE_KEEP_DAYS = 30

/** The rolling window the EA usage stats count, in days. */
export const EA_USAGE_WINDOW_DAYS = 7

/** Where an EA model call ran: on a call, in the typed chat, as an inbox report, or thinking. */
export const EA_USAGE_CHANNELS = ['voice', 'chat', 'inbox', 'think'] as const
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

/** How a think ended: answered, cancelled by the user, out of time, or failed. */
export const EA_THOUGHT_OUTCOMES = ['answered', 'cancelled', 'timed_out', 'failed'] as const
export type EaThoughtOutcome = (typeof EA_THOUGHT_OUTCOMES)[number]

const EA_THOUGHT_QUESTION_MAX = 2000
const EA_THOUGHT_ROUNDS_MAX = 20

/** One think the EA ran, in numbers only: never the question's text. */
export const eaThoughtInput = z.strictObject({
  channel: z.enum(['voice', 'chat']),
  outcome: z.enum(EA_THOUGHT_OUTCOMES),
  question_chars: z.number().int().min(0).max(EA_THOUGHT_QUESTION_MAX),
  duration_ms: latencyMs,
  tool_rounds: z.number().int().min(0).max(EA_THOUGHT_ROUNDS_MAX),
})
export type EaThoughtInput = z.infer<typeof eaThoughtInput>

const OUTCOME_WORDS: Record<EaThoughtOutcome, string> = {
  answered: 'answered',
  cancelled: 'was cancelled',
  timed_out: 'ran out of time',
  failed: 'failed',
}

/** The audit line for a think, such as "EA thought a question through in 23 s: answered". */
export function thoughtSummary({ outcome, duration_ms, tool_rounds }: EaThoughtInput): string {
  const seconds = Math.round(duration_ms / 1000)
  const rounds = tool_rounds === 1 ? '1 round of reading' : `${String(tool_rounds)} rounds of reading`
  return `EA thought a question through in ${String(seconds)} s with ${rounds}: ${OUTCOME_WORDS[outcome]}`
}
