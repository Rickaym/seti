import { z } from 'zod'
import { lenientArray, orDefault, type ResponseSchema } from './lenient.js'

/** The days the shipping metrics count back over, today included, in the reader's timezone. */
export const HOME_DAYS = { week: 7, month: 30 } as const

/** MCP servers listed per agent, most called first. */
export const HOME_MCP_LIMIT = 8

/** The latest merged PRs the metrics list, newest first. */
export const HOME_RECENT_LIMIT = 6

function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export const homeQuery = z.object({
  /** The IANA timezone that days are counted in; left out, the Seti host's. */
  zone: z.string().trim().min(1).max(64).refine(knownZone, 'Unknown timezone').optional(),
})
export type HomeQuery = z.infer<typeof homeQuery>

/** What an agent did over the week and the month: PRs merged, turns, cost and time running. */
export interface HomeTally {
  merged_7d: number
  merged_30d: number
  turns_7d: number
  turns_30d: number
  cost_7d_usd: number
  cost_30d_usd: number
  /** Time its turns ran, as each turn reported it. */
  run_ms_7d: number
  run_ms_30d: number
}

/** An MCP server an agent's tool calls reached in the last 30 days. */
export interface HomeMcpUse {
  server: string
  calls: number
}

export interface HomeAgentStats extends HomeTally {
  task_id: string
  mcp: HomeMcpUse[]
}

/** One day in the reader's timezone: PRs merged, and the turns run with their cost and time. */
export interface HomeDay {
  /** `YYYY-MM-DD`. */
  day: string
  merged: number
  turns: number
  cost_usd: number
  run_ms: number
}

/** A PR that merged in the last 30 days, with the agents it was linked to. */
export interface HomeMerge {
  pr_url: string
  /** When Seti's PR poll first saw it merged. */
  merged_at: string
  task_ids: string[]
}

/** A tool call an agent or one of its subagents runs right now. */
export interface HomeLiveCall {
  task_id: string
  tool: string
  /** The MCP server of an `mcp__<server>__<tool>` call; null for Claude Code's own tools. */
  server: string | null
  /** The Agent call of the subagent that runs it; null for the agent itself. */
  subagent: string | null
  since: string
}

export interface HomeSummary {
  zone: string
  /** Every agent together; a PR linked to two agents counts once. */
  totals: HomeTally
  /** Days in a row, ending today or yesterday, with at least one PR merged. */
  streak_days: number
  /** The last 30 days, oldest first. */
  days: HomeDay[]
  /** Agents with turns or merged PRs in the last 30 days, archived ones included. */
  agents: HomeAgentStats[]
  /** The latest merges, newest first, up to `HOME_RECENT_LIMIT`. */
  recent: HomeMerge[]
  live: HomeLiveCall[]
}

const count = (label: string) => orDefault(label, z.number().nonnegative(), 0)

const tallyFields = {
  merged_7d: count('merged_7d'),
  merged_30d: count('merged_30d'),
  turns_7d: count('turns_7d'),
  turns_30d: count('turns_30d'),
  cost_7d_usd: count('cost_7d_usd'),
  cost_30d_usd: count('cost_30d_usd'),
  run_ms_7d: count('run_ms_7d'),
  run_ms_30d: count('run_ms_30d'),
}

const EMPTY_TALLY: HomeTally = {
  merged_7d: 0,
  merged_30d: 0,
  turns_7d: 0,
  turns_30d: 0,
  cost_7d_usd: 0,
  cost_30d_usd: 0,
  run_ms_7d: 0,
  run_ms_30d: 0,
}

const homeDay = z.object({
  day: z.string(),
  merged: count('merged'),
  turns: count('turns'),
  cost_usd: count('cost_usd'),
  run_ms: count('run_ms'),
})

const homeMerge = z.object({ pr_url: z.string(), merged_at: z.string(), task_ids: z.array(z.string()) })

/** The Home page reads `GET /api/home` with this, keeping what parses when a field drifts. */
export const homeSummarySchema: ResponseSchema<HomeSummary> = z.object({
  zone: z.string(),
  totals: orDefault('home totals', z.object(tallyFields), EMPTY_TALLY),
  streak_days: count('streak_days'),
  days: lenientArray('home day', homeDay),
  agents: lenientArray(
    'home agent',
    z.object({
      task_id: z.string(),
      ...tallyFields,
      mcp: lenientArray('mcp use', z.object({ server: z.string(), calls: count('calls') })),
    }),
  ),
  recent: lenientArray('home merge', homeMerge),
  live: lenientArray(
    'live call',
    z.object({
      task_id: z.string(),
      tool: z.string(),
      server: orDefault('live server', z.string().nullable(), null),
      subagent: orDefault('live subagent', z.string().nullable(), null),
      since: z.string(),
    }),
  ),
})
