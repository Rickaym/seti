import type { AccessKind, CredentialAccessEntry } from '@seti/shared'
import { now, sql } from '../db.js'

type Choices = Record<string, boolean>

interface Row {
  item: string
  enabled: boolean
}

/** What a credential's agents follow unless they chose their own; no row means no opinion. */
export const credentialAccess = {
  of: async (profileId: string, kind: AccessKind): Promise<Choices> =>
    Object.fromEntries(
      (
        await sql<Row[]>`SELECT item, enabled FROM credential_access
          WHERE profile_id = ${profileId} AND kind = ${kind} ORDER BY item`
      ).map((row) => [row.item, row.enabled]),
    ),
  all: async (profileId: string): Promise<CredentialAccessEntry[]> =>
    sql<CredentialAccessEntry[]>`SELECT kind, item AS id, enabled FROM credential_access
      WHERE profile_id = ${profileId} ORDER BY kind, item`,
  /** Sets one entry, or with null drops it so the credential has no opinion; true when it changed. */
  set: async (profileId: string, kind: AccessKind, item: string, enabled: boolean | null): Promise<boolean> => {
    if (enabled === null) {
      return (
        (await sql`DELETE FROM credential_access WHERE profile_id = ${profileId} AND kind = ${kind} AND item = ${item}`)
          .count > 0
      )
    }
    return (
      (
        await sql`INSERT INTO credential_access (profile_id, kind, item, enabled, updated_at)
        VALUES (${profileId}, ${kind}, ${item}, ${enabled}, ${now()})
        ON CONFLICT (profile_id, kind, item) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
        WHERE credential_access.enabled <> excluded.enabled`
      ).count > 0
    )
  },
}

/** Hosts a credential's agents reach beside the shared allowlist and their own. */
export const credentialHosts = {
  list: async (profileId: string): Promise<string[]> =>
    (
      await sql<{ host: string }[]>`SELECT host FROM credential_host WHERE profile_id = ${profileId}
        ORDER BY host`
    ).map((row) => row.host),
  /** Adds or removes one host; true when that changed the list. */
  set: async (profileId: string, host: string, on: boolean): Promise<boolean> =>
    (on
      ? await sql`INSERT INTO credential_host (profile_id, host, created_at) VALUES (${profileId}, ${host}, ${now()})
          ON CONFLICT DO NOTHING`
      : await sql`DELETE FROM credential_host WHERE profile_id = ${profileId} AND host = ${host}`
    ).count > 0,
  forTask: async (taskId: string): Promise<string[]> =>
    (
      await sql<{ host: string }[]>`SELECT h.host FROM credential_host h JOIN task t ON t.profile_id = h.profile_id
        WHERE t.id = ${taskId} ORDER BY h.host`
    ).map((row) => row.host),
}
