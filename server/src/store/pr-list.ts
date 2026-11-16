import { now, sql } from '../db.js'

/** The last PR list read from GitHub, as JSON text, and when it was read. */
export interface StoredPrList {
  payload: string
  fetched_at: string
}

export const prListStore = {
  read: async (): Promise<StoredPrList | undefined> => {
    const [row] = await sql<StoredPrList[]>`SELECT payload, fetched_at FROM pr_list_cache WHERE id = 1`
    return row
  },
  write: async (payload: string): Promise<void> => {
    await sql`INSERT INTO pr_list_cache (id, payload, fetched_at) VALUES (1, ${payload}, ${now()})
      ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
  },
}
