import { STORAGE_SCHEDULE_DEFAULTS, type ScheduleIdleDays, type StorageSchedule } from '@seti/shared'
import { now, sql } from '../db.js'

interface SettingsRow {
  auto_clean: boolean
  idle_days: ScheduleIdleDays
  last_run_at: string | null
  last_freed_bytes: number | null
}

/** The automatic clean's switch, its idle days and what its last run freed. */
export const storageSettings = {
  get: async (): Promise<StorageSchedule> => {
    const [row] = await sql<SettingsRow[]>`SELECT auto_clean, idle_days, last_run_at, last_freed_bytes
      FROM storage_settings WHERE id = 1`
    return row === undefined
      ? STORAGE_SCHEDULE_DEFAULTS
      : {
          enabled: row.auto_clean,
          idle_days: row.idle_days,
          last_run_at: row.last_run_at,
          last_freed_bytes: row.last_freed_bytes,
        }
  },
  set: async (input: Pick<StorageSchedule, 'enabled' | 'idle_days'>): Promise<void> => {
    await sql`INSERT INTO storage_settings (id, auto_clean, idle_days, updated_at)
      VALUES (1, ${input.enabled}, ${input.idle_days}, ${now()})
      ON CONFLICT (id) DO UPDATE SET auto_clean = excluded.auto_clean, idle_days = excluded.idle_days,
        updated_at = excluded.updated_at`
  },
  ran: async (at: string, freed: number): Promise<void> => {
    await sql`INSERT INTO storage_settings (id, last_run_at, last_freed_bytes, updated_at)
      VALUES (1, ${at}, ${freed}, ${at})
      ON CONFLICT (id) DO UPDATE SET last_run_at = excluded.last_run_at,
        last_freed_bytes = excluded.last_freed_bytes`
  },
}
