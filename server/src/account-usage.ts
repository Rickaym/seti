import type { UsageWindow } from '@seti/shared'
import { z } from 'zod'

const PLAN_WINDOWS = [
  ['five_hour', '5-hour'],
  ['seven_day', 'Weekly'],
  ['seven_day_opus', 'Weekly Opus'],
  ['seven_day_sonnet', 'Weekly Sonnet'],
  ['seven_day_oauth_apps', 'Weekly OAuth apps'],
] as const

const windowSchema = z.object({ utilization: z.number().nullish(), resets_at: z.string().nullish() }).nullish()

const usageSchema = z.object({
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: windowSchema,
      seven_day: windowSchema,
      seven_day_opus: windowSchema,
      seven_day_sonnet: windowSchema,
      seven_day_oauth_apps: windowSchema,
      model_scoped: z
        .array(
          z.object({ display_name: z.string(), utilization: z.number().nullish(), resets_at: z.string().nullish() }),
        )
        .optional(),
    })
    .nullable(),
})

export type UsageReading = { ok: true; windows: UsageWindow[] } | { ok: false; reason: string }

type RawWindow = { utilization?: number | null | undefined; resets_at?: string | null | undefined } | null | undefined

function toWindow(key: string, label: string, raw: RawWindow): UsageWindow[] {
  const utilization = raw?.utilization ?? null
  const resetsAt = raw?.resets_at ?? null
  return utilization === null && resetsAt === null ? [] : [{ key, label, utilization, resets_at: resetsAt }]
}

/** Parses the usage API result; the API is unstable, so any unexpected shape means "unavailable". */
export function parseUsage(raw: unknown): UsageReading {
  const parsed = usageSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: 'The Claude Code usage API returned an unexpected shape' }
  }
  const limits = parsed.data.rate_limits
  if (!parsed.data.rate_limits_available || limits === null) {
    return { ok: false, reason: 'Plan limits do not apply to this login' }
  }
  const windows = [
    ...PLAN_WINDOWS.flatMap(([key, label]) => toWindow(key, label, limits[key])),
    ...(limits.model_scoped ?? []).flatMap((scoped) =>
      toWindow(`model:${scoped.display_name}`, `Weekly ${scoped.display_name}`, scoped),
    ),
  ]
  return windows.length === 0 ? { ok: false, reason: 'The usage API reported no plan windows' } : { ok: true, windows }
}

const epochSeconds = z.number().transform((seconds) => new Date(seconds * 1000).toISOString())
const fraction = z.number().transform((value) => Math.round(value * 1000) / 10)

const streamWindow = z.object({ utilization: fraction.optional(), resetsAt: epochSeconds.optional() })

const rateLimitEventSchema = z.object({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.object({
    status: z.string(),
    rateLimitType: z.string().optional(),
    utilization: fraction.optional(),
    resetsAt: epochSeconds.optional(),
    unifiedWindows: z.record(z.string(), streamWindow).optional(),
  }),
})

const labelFor = (key: string) => PLAN_WINDOWS.find(([known]) => known === key)?.[1] ?? key

const streamWindowOf = (key: string, raw: z.infer<typeof streamWindow>): UsageWindow[] =>
  toWindow(key, labelFor(key), { utilization: raw.utilization, resets_at: raw.resetsAt })

/** Reads a stored rate_limit_event; its utilization is a 0-1 fraction, resets are epoch seconds. */
export function parseRateLimitEvent(
  raw: unknown,
): { status: string; rate_limit_type: string | null; windows: UsageWindow[] } | null {
  const parsed = rateLimitEventSchema.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  const info = parsed.data.rate_limit_info
  const type = info.rateLimitType ?? null
  const unified = Object.entries(info.unifiedWindows ?? {}).flatMap(([key, value]) => streamWindowOf(key, value))
  const windows =
    unified.length > 0 || type === null
      ? unified
      : streamWindowOf(type, { utilization: info.utilization, resetsAt: info.resetsAt })
  return { status: info.status, rate_limit_type: type, windows }
}

/** Overlays newer windows on older ones by key, keeping the older order and appending new keys. */
export function mergeWindows(older: readonly UsageWindow[], newer: readonly UsageWindow[]): UsageWindow[] {
  const byKey = new Map(newer.map((w) => [w.key, w]))
  const kept = older.map((w) => byKey.get(w.key) ?? w)
  const known = new Set(older.map((w) => w.key))
  return [...kept, ...newer.filter((w) => !known.has(w.key))]
}
