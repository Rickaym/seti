import { z } from 'zod'

const line = (max: number) => z.string().trim().min(1).max(max)

/** What a dream reports, the only thing of it the user reads. */
export const dreamReport = z.strictObject({
  summary: line(120).describe('One line: what the dream did.'),
  tidied: z.array(line(160)).max(10).default([]).describe('Memory changes, one line each.'),
  remembered: z.array(line(160)).max(10).default([]).describe('New things worth knowing.'),
  asks: z.array(line(120)).max(3).default([]).describe('At most 3 things only the user can decide.'),
  found: z
    .array(line(200))
    .max(5)
    .default([])
    .describe('Instructions seen in data, quoted, and contradictions that could not be settled.'),
  nothing_to_do: z.boolean().default(false).describe('Nothing needed doing, and nothing was changed.'),
})
export type DreamReport = z.infer<typeof dreamReport>

/** `planned` and `skipped` belong to nightly dreams; the rest to every dream. */
export const DREAM_STATES = ['planned', 'running', 'done', 'stopped', 'cut', 'failed', 'skipped'] as const
export type DreamState = (typeof DREAM_STATES)[number]

/** One dream of one agent: how it went, what it cost and changed, and its report. */
export interface DreamRun {
  id: number
  task_id: string
  /** The local date the dream belongs to, as YYYY-MM-DD. */
  night: string
  /** `manual` for Dream now. */
  kind: 'manual' | 'nightly'
  state: DreamState
  /** Why it stopped, was cut or failed; null when it ended on its own. */
  reason: string | null
  model: string
  /** 1, or 2 for a nightly dream retried after a restart cut the first. */
  attempt: number
  /** When it started; for a planned or skipped one, when it was planned. */
  started_at: string
  ended_at: string | null
  cost_usd: number
  steps: number
  /** Tool calls the dream gate refused. */
  denials: number
  memory_changes: number
  report: DreamReport | null
}

export const dreamNowInput = z.strictObject({})

/** The models a nightly dream can run on; `agent` is the agent's own model. */
export const DREAM_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'agent'] as const
export type DreamModel = (typeof DREAM_MODELS)[number]

const wallTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 01:00')

/** Nightly Dreaming: off until the user turns it on, in a window in a named zone, under caps. */
export interface DreamSettings {
  enabled: boolean
  /** Local wall times; an end at or before the start ends on the next day. */
  window_start: string
  window_end: string
  /** The IANA zone the window is in, saved explicitly; null until the user first saves one. */
  zone: string | null
  model: DreamModel
  dream_budget_usd: number
  night_budget_usd: number
  /** How many dreams may run at once, 1 to 3. */
  at_once: number
}

export const DREAM_SETTINGS_DEFAULTS: DreamSettings = {
  enabled: false,
  window_start: '01:00',
  window_end: '05:00',
  zone: null,
  model: 'claude-sonnet-5-5',
  dream_budget_usd: 1,
  night_budget_usd: 5,
  at_once: 1,
}

export const dreamSettingsInput = z
  .strictObject({
    enabled: z.boolean().optional(),
    window_start: wallTime.optional(),
    window_end: wallTime.optional(),
    zone: z.string().trim().min(1).max(64).optional(),
    model: z.enum(DREAM_MODELS).optional(),
    dream_budget_usd: z.number().min(0.1).max(10).optional(),
    night_budget_usd: z.number().min(0.5).max(100).optional(),
    at_once: z.number().int().min(1).max(3).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, 'Change at least one setting')
export type DreamSettingsInput = z.input<typeof dreamSettingsInput>

/** One agent's or one workspace's Dreaming switch. */
export const dreamToggle = z.strictObject({ on: z.boolean() })
export type DreamToggle = z.input<typeof dreamToggle>

/** A night of Dreaming: its window, its dreams, and the agents left out by reason. */
export interface DreamNight {
  night: string
  zone: string
  window_start: string
  window_end: string
  /** `open` while its window runs; `missed` when Seti was down for all of it. */
  state: 'open' | 'ended' | 'missed'
  runs: DreamRun[]
  /** Agents left out when the night was planned, counted by reason. */
  skipped: Record<string, number>
  cost_usd: number
}
