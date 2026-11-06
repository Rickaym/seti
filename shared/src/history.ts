import { z } from 'zod'

const WINDOW_LINES_MAX = 200
const ACTIVITY_LIMIT_MAX = 100
const bound = z.string().trim().min(1).max(40)

/**
 * A time window. Each end is today, yesterday, a date such as 2026-10-27 or an ISO time; a date
 * as `until` includes that whole day. Times without an offset are read in `timezone`.
 */
const historyWindowQuery = z.object({
  since: bound.optional(),
  until: bound.optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
})
export type HistoryWindowQuery = z.output<typeof historyWindowQuery>

/** One agent's condensed transcript in a window, newest `limit` lines, paged older by `cursor`. */
export const transcriptWindowQuery = historyWindowQuery.extend({
  include_tools: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(WINDOW_LINES_MAX).default(50),
  cursor: z.coerce.number().int().min(1).optional(),
})
export type TranscriptWindowQuery = z.output<typeof transcriptWindowQuery>

/** Every agent with turns in a window, most active first. */
export const agentActivityQuery = historyWindowQuery.extend({
  limit: z.coerce.number().int().min(1).max(ACTIVITY_LIMIT_MAX).default(30),
})
export type AgentActivityQuery = z.output<typeof agentActivityQuery>

/** A window as it was read: both ends in local time, the timezone and where that came from. */
export interface HistoryWindow {
  since: string | null
  until: string | null
  timezone: string
  timezone_from: string
}

export interface TranscriptWindow {
  task: { id: string; title: string; archived: boolean }
  window: HistoryWindow
  /** Oldest first, each `YYYY-MM-DD HH:MM kind: text` in the window's timezone. */
  lines: string[]
  /** Pass as `cursor` to read the lines before these; null when none are left in the window. */
  older_cursor: number | null
}

export interface AgentActivityEntry {
  id: string
  title: string
  workspace: string | null
  status: string
  prompts: number
  update_turns: number
  replies: number
  first_at: string
  last_at: string
  prs_linked: string[]
  last_reply: string | null
}

export interface AgentActivity {
  window: HistoryWindow
  agents: AgentActivityEntry[]
  /** Agents active in the window beyond `limit`. */
  more: number
  /** Agents archived since the window began, whose turns these counts no longer hold. */
  archived_since: { id: string; title: string; archived_at: string }[]
}
