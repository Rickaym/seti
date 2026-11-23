import { DREAM_SETTINGS_DEFAULTS, type DreamNight, type DreamSettings } from '@seti/shared'
import { now, sql, transaction } from '../db.js'
import { toRun, type DreamRecord } from './dreams.js'

interface SettingsRow extends Omit<DreamSettings, 'dream_budget_usd' | 'night_budget_usd'> {
  dream_budget_usd: number | string
  night_budget_usd: number | string
}

/** Dreaming's settings: off, 01:00 to 05:00, no zone, until the user saves them. */
export const dreamSettings = {
  get: async (): Promise<DreamSettings> => {
    const [row] = await sql<SettingsRow[]>`SELECT enabled, window_start, window_end, zone, model,
        dream_budget_usd, night_budget_usd, at_once FROM dream_settings WHERE id = 1`
    return row === undefined
      ? DREAM_SETTINGS_DEFAULTS
      : {
          ...row,
          dream_budget_usd: Number(row.dream_budget_usd),
          night_budget_usd: Number(row.night_budget_usd),
        }
  },
  set: async (next: DreamSettings): Promise<void> => {
    await sql`INSERT INTO dream_settings (id, enabled, window_start, window_end, zone, model,
        dream_budget_usd, night_budget_usd, at_once, updated_at)
      VALUES (1, ${next.enabled}, ${next.window_start}, ${next.window_end}, ${next.zone}, ${next.model},
        ${next.dream_budget_usd}, ${next.night_budget_usd}, ${next.at_once}, ${now()})
      ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, window_start = excluded.window_start,
        window_end = excluded.window_end, zone = excluded.zone, model = excluded.model,
        dream_budget_usd = excluded.dream_budget_usd, night_budget_usd = excluded.night_budget_usd,
        at_once = excluded.at_once, updated_at = excluded.updated_at`
  },
  /** When the settings were last saved, or null when they never were. */
  savedAt: async (): Promise<string | null> => {
    const [row] = await sql<{ updated_at: string }[]>`SELECT updated_at FROM dream_settings WHERE id = 1`
    return row?.updated_at ?? null
  },
}

/** Agents and workspaces switched out of Dreaming; both are in unless switched out. */
export const dreamOptOuts = {
  get: async (): Promise<{ tasks: Set<string>; workspaces: Set<string> }> => {
    const rows = await sql<{ task_id: string | null; workspace_id: string | null }[]>`
      SELECT task_id, workspace_id FROM dream_opt_out`
    return {
      tasks: new Set(rows.flatMap((row) => (row.task_id === null ? [] : [row.task_id]))),
      workspaces: new Set(rows.flatMap((row) => (row.workspace_id === null ? [] : [row.workspace_id]))),
    }
  },
  setTask: async (taskId: string, on: boolean): Promise<void> => {
    await (on
      ? sql`DELETE FROM dream_opt_out WHERE task_id = ${taskId}`
      : sql`INSERT INTO dream_opt_out (task_id, created_at) VALUES (${taskId}, ${now()}) ON CONFLICT DO NOTHING`)
  },
  setWorkspace: async (workspaceId: string, on: boolean): Promise<void> => {
    await (on
      ? sql`DELETE FROM dream_opt_out WHERE workspace_id = ${workspaceId}`
      : sql`INSERT INTO dream_opt_out (workspace_id, created_at) VALUES (${workspaceId}, ${now()})
          ON CONFLICT DO NOTHING`)
  },
}

type NightRow = Omit<DreamNight, 'runs' | 'cost_usd'>

/** A night as planned: its window in UTC and the agents left out by reason. */
export interface NightPlan {
  night: string
  zone: string
  window_start: string
  window_end: string
  skipped: Record<string, number>
}

/** A nightly dream to plan: the agent, and when it may start at the earliest. */
export interface PlannedDream {
  task_id: string
  not_before: string
  model: string
}

export const dreamNights = {
  /** Writes the night and its planned dreams once; false when it was planned before. */
  plan: async (plan: NightPlan, dreams: readonly PlannedDream[]): Promise<boolean> =>
    transaction(async (tx) => {
      const at = now()
      const [row] = await tx<{ night: string }[]>`INSERT INTO dream_night
          (night, zone, window_start, window_end, state, skipped, created_at)
        VALUES (${plan.night}, ${plan.zone}, ${plan.window_start}, ${plan.window_end}, 'open',
          ${tx.json(plan.skipped)}, ${at})
        ON CONFLICT (night) DO NOTHING RETURNING night`
      if (row === undefined) {
        return false
      }
      for (const dream of dreams) {
        await tx`INSERT INTO dream_run (task_id, night, kind, state, model, started_at, not_before)
          VALUES (${dream.task_id}, ${plan.night}, 'nightly', 'planned', ${dream.model}, ${at}, ${dream.not_before})
          ON CONFLICT DO NOTHING`
      }
      return true
    }),
  /** Records a night Seti was down for, once. */
  missed: async (plan: NightPlan): Promise<boolean> => {
    const at = now()
    const rows = await sql`INSERT INTO dream_night (night, zone, window_start, window_end, state, created_at, ended_at)
      VALUES (${plan.night}, ${plan.zone}, ${plan.window_start}, ${plan.window_end}, 'missed', ${at}, ${at})
      ON CONFLICT (night) DO NOTHING RETURNING night`
    return rows.length > 0
  },
  get: async (night: string): Promise<NightRow | undefined> => {
    const [row] = await sql<NightRow[]>`SELECT night, zone, window_start, window_end, state, skipped
      FROM dream_night WHERE night = ${night}`
    return row
  },
  /** The newest night that has a plan or a record, if any. */
  latest: async (): Promise<NightRow | undefined> => {
    const [row] = await sql<NightRow[]>`SELECT night, zone, window_start, window_end, state, skipped
      FROM dream_night ORDER BY night DESC LIMIT 1`
    return row
  },
  /** Nights still open, oldest first. */
  open: async (): Promise<NightRow[]> =>
    sql<NightRow[]>`SELECT night, zone, window_start, window_end, state, skipped
      FROM dream_night WHERE state = 'open' ORDER BY night`,
  end: async (night: string): Promise<void> => {
    await sql`UPDATE dream_night SET state = 'ended', ended_at = ${now()} WHERE night = ${night} AND state = 'open'`
  },
  /** Nights whose window ended between two instants, for the brief. */
  endedBetween: async (since: string, at: string): Promise<NightRow[]> =>
    sql<NightRow[]>`SELECT night, zone, window_start, window_end, state, skipped FROM dream_night
      WHERE state = 'ended' AND ended_at > ${since} AND ended_at <= ${at} ORDER BY night`,
}

export const nightRuns = {
  /** Every dream of a night, nightly and manual, oldest first. */
  of: async (night: string) =>
    (await sql<DreamRecord[]>`SELECT * FROM dream_run WHERE night = ${night} ORDER BY id`).map(toRun),
  /** What the night's dreams cost so far, Dream now included. */
  cost: async (night: string): Promise<number> => {
    const [row] = await sql<{ sum: string | null }[]>`SELECT SUM(cost_usd) AS sum FROM dream_run WHERE night = ${night}`
    return Number(row?.sum ?? 0)
  },
  /** How many dreams run now, and when the night's last nightly dream started. */
  load: async (night: string): Promise<{ running: number; lastStart: string | null }> => {
    const [row] = await sql<{ running: string; last: string | null }[]>`SELECT
        COUNT(*) FILTER (WHERE state = 'running') AS running,
        MAX(started_at) FILTER (WHERE night = ${night} AND kind = 'nightly'
          AND state NOT IN ('planned', 'skipped')) AS last
      FROM dream_run`
    return { running: Number(row?.running ?? 0), lastStart: row?.last ?? null }
  },
  /** The night's planned dreams that may start at an instant, in their planned order. */
  due: async (night: string, at: string) =>
    (
      await sql<DreamRecord[]>`SELECT * FROM dream_run WHERE night = ${night} AND state = 'planned'
        AND kind = 'nightly' AND not_before <= ${at} ORDER BY not_before, id`
    ).map(toRun),
  /** Starts a planned dream unless another tick took it; undefined when one did. */
  claim: async (id: number, model: string, at = now()) => {
    const [row] = await sql<DreamRecord[]>`UPDATE dream_run SET state = 'running', model = ${model},
        started_at = ${at}, reason = NULL WHERE id = ${id} AND state = 'planned' RETURNING *`
    return row && toRun(row)
  },
  /** Holds a planned dream back until an instant, keeping why. */
  defer: async (id: number, until: string, reason: string): Promise<void> => {
    await sql`UPDATE dream_run SET not_before = ${until}, reason = ${reason} WHERE id = ${id} AND state = 'planned'`
  },
  /** Notes why the night's planned dreams wait, for the reason they are skipped with at its end. */
  waiting: async (night: string, reason: string): Promise<void> => {
    await sql`UPDATE dream_run SET reason = ${reason} WHERE night = ${night} AND state = 'planned'`
  },
  skip: async (id: number, reason: string): Promise<void> => {
    await sql`UPDATE dream_run SET state = 'skipped', reason = ${reason}, ended_at = ${now()}
      WHERE id = ${id} AND state = 'planned'`
  },
  /** Skips every planned dream of a night, with its last reason or the one given. */
  skipPlanned: async (night: string, fallback: string): Promise<number> => {
    const rows = await sql`UPDATE dream_run SET state = 'skipped', reason = COALESCE(reason, ${fallback}),
        ended_at = ${now()} WHERE night = ${night} AND state = 'planned' RETURNING id`
    return rows.length
  },
  /** Plans again, once, the night's dreams a restart or a turn cut, after the others. */
  retryCut: async (night: string, notBefore: string): Promise<number> => {
    const rows = await sql`UPDATE dream_run SET state = 'planned', attempt = 2, not_before = ${notBefore},
        ended_at = NULL WHERE night = ${night} AND kind = 'nightly' AND state = 'cut' AND attempt = 1 RETURNING id`
    return rows.length
  },
  /** At the night's end, a dream cut on both attempts has failed. */
  failTwiceCut: async (night: string): Promise<void> => {
    await sql`UPDATE dream_run SET state = 'failed', reason = 'A restart or a turn cut it twice.'
      WHERE night = ${night} AND kind = 'nightly' AND state = 'cut' AND attempt >= 2`
  },
}

/** Per agent, the user's messages and tool steps since its last finished dream (or ever). */
export async function activitySinceLastDream(taskIds: readonly string[]): Promise<Map<string, number>> {
  if (taskIds.length === 0) {
    return new Map()
  }
  const rows = await sql<{ task_id: string; activity: string }[]>`
    SELECT t.id AS task_id, (
      SELECT COUNT(*) + COALESCE(SUM(m.turn_steps), 0) FROM task_message m
      WHERE m.task_id = t.id AND m.created_at > COALESCE((SELECT MAX(d.ended_at) FROM dream_run d
          WHERE d.task_id = t.id AND d.state = 'done'), '')
        AND ((m.kind = 'prompt' AND (m.payload::json ->> 'auto') IS DISTINCT FROM 'true'
            AND (m.payload::json ->> 'queued') IS DISTINCT FROM 'removed')
          OR m.turn_steps > 0)
    ) AS activity
    FROM task t WHERE t.id = ANY(${[...taskIds]})`
  return new Map(rows.map((row) => [row.task_id, Number(row.activity)]))
}
