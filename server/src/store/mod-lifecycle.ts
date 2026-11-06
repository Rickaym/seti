import { now, sql } from '../db.js'

/** A bisect in progress: every mod's state before it started, and the mods still suspected. */
export interface BisectRow {
  original: Record<string, boolean>
  suspects: string[]
  /** The suspects turned off in the step the user is answering. */
  off: string[]
  step: number
  started_at: string
}

export const modBisectRows = {
  get: async (): Promise<BisectRow | null> => {
    const [row] = await sql<
      { original: Record<string, boolean>; suspects: unknown; step: number; started_at: string }[]
    >`
      SELECT original, suspects, step, started_at FROM mod_bisect WHERE id = 1`
    if (row === undefined) {
      return null
    }
    const suspects = row.suspects as { all: string[]; off: string[] }
    return {
      original: row.original,
      suspects: suspects.all,
      off: suspects.off,
      step: row.step,
      started_at: row.started_at,
    }
  },
  put: async (row: BisectRow): Promise<void> => {
    const original = JSON.stringify(row.original)
    const suspects = JSON.stringify({ all: row.suspects, off: row.off })
    await sql`INSERT INTO mod_bisect (id, original, suspects, step, started_at)
      VALUES (1, ${original}::text::jsonb, ${suspects}::text::jsonb, ${row.step}, ${row.started_at})
      ON CONFLICT (id) DO UPDATE SET original = excluded.original, suspects = excluded.suspects, step = excluded.step`
  },
  clear: async (): Promise<void> => {
    await sql`DELETE FROM mod_bisect WHERE id = 1`
  },
}

export const modDevMode = {
  get: async (): Promise<boolean> =>
    (await sql<{ dev_mode: boolean }[]>`SELECT dev_mode FROM mod_host WHERE id = 1`).at(0)?.dev_mode ?? false,
  set: async (on: boolean): Promise<void> => {
    await sql`INSERT INTO mod_host (id, safe_mode, dev_mode, updated_at) VALUES (1, false, ${on}, ${now()})
      ON CONFLICT (id) DO UPDATE SET dev_mode = excluded.dev_mode, updated_at = excluded.updated_at`
  },
}
