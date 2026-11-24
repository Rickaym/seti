import { sql } from '../db.js'

/** A Slack id with the name Seti saw beside it. */
export interface SlackName {
  id: string
  kind: 'channel' | 'user'
  name: string
}

export const slackNames = {
  /** Stores what Seti saw; a different name replaces the old one, so a rename is corrected. */
  learn: async (names: readonly SlackName[], source: string, at: string): Promise<void> => {
    for (const { id, kind, name } of names) {
      await sql`INSERT INTO slack_name (id, kind, name, source, learned_at)
        VALUES (${id}, ${kind}, ${name}, ${source}, ${at})
        ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, source = excluded.source,
          learned_at = excluded.learned_at
        WHERE slack_name.name <> excluded.name OR slack_name.kind <> excluded.kind`
    }
  },
  /** The names Seti knows for these ids; an unknown id is absent. */
  of: async (ids: readonly string[]): Promise<Map<string, string>> => {
    const unique = [...new Set(ids)]
    if (unique.length === 0) {
      return new Map()
    }
    const rows = await sql<{ id: string; name: string }[]>`SELECT id, name FROM slack_name WHERE id IN ${sql(unique)}`
    return new Map(rows.map((row) => [row.id, row.name]))
  },
}
