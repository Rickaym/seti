import { now, sql } from '../db.js'

export const changelogStore = {
  /** Notes that Seti started at `sha`; a restart at a known commit moves its time forward. */
  recordDeploy: async (sha: string): Promise<void> => {
    await sql`INSERT INTO seti_deploy (sha, started_at) VALUES (${sha}, ${now()})
      ON CONFLICT (sha) DO UPDATE SET started_at = excluded.started_at`
  },
  /** The commit Seti last started at before `sha`, or null. */
  previousDeploy: async (sha: string): Promise<string | null> =>
    (
      await sql<{ sha: string }[]>`SELECT sha FROM seti_deploy WHERE sha <> ${sha}
        ORDER BY started_at DESC, sha LIMIT 1`
    ).at(0)?.sha ?? null,
  seen: async (): Promise<string | null> =>
    (await sql<{ sha: string }[]>`SELECT sha FROM changelog_seen WHERE id = 1`).at(0)?.sha ?? null,
  markSeen: async (sha: string): Promise<void> => {
    await sql`INSERT INTO changelog_seen (id, sha, seen_at) VALUES (1, ${sha}, ${now()})
      ON CONFLICT (id) DO UPDATE SET sha = excluded.sha, seen_at = excluded.seen_at`
  },
}
