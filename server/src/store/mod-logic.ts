import { MOD_LIMITS, type ModLogLine } from '@seti/shared'
import { sql } from '../db.js'

/** One line for a mod's own log; the text is already clipped and has no secret in it. */
export type ModLogEntry = Pick<ModLogLine, 'kind' | 'level' | 'line'>

export const modLogs = {
  /** Adds lines from one event, or Seti's own about the mod, and keeps the newest per mod. */
  append: async (modId: string, eventId: string | null, at: string, entries: readonly ModLogEntry[]) => {
    if (entries.length === 0) {
      return
    }
    await sql`INSERT INTO mod_log (mod_id, at, event_id, kind, level, line)
      SELECT ${modId}, ${at}, ${eventId}, k, l, t FROM unnest(
        ${entries.map((entry) => entry.kind)}::text[],
        ${entries.map((entry) => entry.level)}::text[],
        ${entries.map((entry) => entry.line)}::text[]
      ) AS x(k, l, t)`
    await sql`DELETE FROM mod_log WHERE mod_id = ${modId} AND id < (
      SELECT id FROM mod_log WHERE mod_id = ${modId} ORDER BY id DESC OFFSET ${MOD_LIMITS.logKeptLines - 1} LIMIT 1)`
  },
  /** The newest lines first. */
  newest: async (modId: string, limit: number): Promise<ModLogLine[]> =>
    sql<ModLogLine[]>`SELECT at, event_id, kind, level, line FROM mod_log
      WHERE mod_id = ${modId} ORDER BY id DESC LIMIT ${limit}`,
  /** A line Seti itself writes about the mod, such as a refused load. */
  system: async (modId: string, line: string, level: ModLogLine['level'] = 'info'): Promise<void> =>
    modLogs.append(modId, null, new Date().toISOString(), [{ kind: 'system', level, line }]),
  /** Its newest error line, for its card and the EA's list. */
  lastError: async (modId: string): Promise<string | null> =>
    (
      await sql<{ line: string }[]>`SELECT line FROM mod_log WHERE mod_id = ${modId} AND level = 'error'
        ORDER BY id DESC LIMIT 1`
    ).at(0)?.line ?? null,
  /** Every line of a mod, as its uninstall deletes its data. */
  clear: async (modId: string): Promise<void> => {
    await sql`DELETE FROM mod_log WHERE mod_id = ${modId}`
  },
}

export const modUsage = {
  /** Counts one event toward its day: its compute, and whether it failed. */
  add: async (modId: string, day: string, cpuMs: number, failed: boolean): Promise<void> => {
    const failures = failed ? 1 : 0
    await sql`INSERT INTO mod_usage (mod_id, day, cpu_ms, events, failures)
      VALUES (${modId}, ${day}, ${Math.round(cpuMs)}, 1, ${failures})
      ON CONFLICT (mod_id, day) DO UPDATE SET cpu_ms = mod_usage.cpu_ms + excluded.cpu_ms,
        events = mod_usage.events + 1, failures = mod_usage.failures + excluded.failures`
  },
  /** The compute a mod used on a day, in ms. */
  cpuOn: async (modId: string, day: string): Promise<number> =>
    (await sql<{ cpu_ms: number }[]>`SELECT cpu_ms FROM mod_usage WHERE mod_id = ${modId} AND day = ${day}`).at(0)
      ?.cpu_ms ?? 0,
}
