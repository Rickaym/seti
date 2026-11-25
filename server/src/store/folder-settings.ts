import { now, sql } from '../db.js'

export interface WatchedFile {
  path: string
  /** The content's digest when the file appeared while watched; null while it is still missing. */
  appeared_hash: string | null
}

export const folderSettingsWatch = {
  /** The watched files among these paths. */
  of: async (paths: readonly string[]): Promise<WatchedFile[]> =>
    paths.length === 0
      ? []
      : sql<WatchedFile[]>`SELECT path, appeared_hash FROM folder_settings_watch WHERE path IN ${sql([...paths])}`,
  /** Watches a missing file, or watches it again as missing. */
  missing: async (path: string): Promise<void> => {
    await sql`INSERT INTO folder_settings_watch (path, appeared_hash, watched_at) VALUES (${path}, NULL, ${now()})
      ON CONFLICT (path) DO UPDATE SET appeared_hash = NULL, watched_at = excluded.watched_at`
  },
  /** Notes the content a watched file appeared with. */
  appeared: async (path: string, hash: string): Promise<void> => {
    await sql`UPDATE folder_settings_watch SET appeared_hash = ${hash} WHERE path = ${path}`
  },
  /** Stops watching a file whose content changed outside every agent's session. */
  forget: async (path: string): Promise<void> => {
    await sql`DELETE FROM folder_settings_watch WHERE path = ${path}`
  },
}
