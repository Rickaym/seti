import { now, sql } from '../db.js'

/** The kinds kept in access_default and task_access; MCP, packs and plugins have their own tables. */
export type StoredAccessKind = 'ssh' | 'aws'

type Choices = Record<string, boolean>

interface Row {
  item: string
  enabled: boolean
}

const toChoices = (rows: readonly Row[]): Choices => Object.fromEntries(rows.map((row) => [row.item, row.enabled]))

/** What agents without an override get; an item without a row is off. */
export const accessDefaults = {
  all: async (kind: StoredAccessKind): Promise<Choices> =>
    toChoices(await sql<Row[]>`SELECT item, enabled FROM access_default WHERE kind = ${kind} ORDER BY item`),
  set: async (kind: StoredAccessKind, item: string, enabled: boolean): Promise<void> => {
    if (!enabled) {
      await sql`DELETE FROM access_default WHERE kind = ${kind} AND item = ${item}`
      return
    }
    await sql`INSERT INTO access_default (kind, item, enabled, updated_at) VALUES (${kind}, ${item}, true, ${now()})
      ON CONFLICT (kind, item) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  },
}

/** A task's overrides; each is stored only while it differs from the default. */
export const taskAccess = {
  all: async (taskId: string, kind: StoredAccessKind): Promise<Choices> =>
    toChoices(
      await sql<Row[]>`SELECT item, enabled FROM task_access WHERE task_id = ${taskId} AND kind = ${kind}
        ORDER BY item`,
    ),
  set: async (taskId: string, kind: StoredAccessKind, item: string, enabled: boolean | null): Promise<void> => {
    if (enabled === null) {
      await sql`DELETE FROM task_access WHERE task_id = ${taskId} AND kind = ${kind} AND item = ${item}`
      return
    }
    await sql`INSERT INTO task_access (task_id, kind, item, enabled) VALUES (${taskId}, ${kind}, ${item}, ${enabled})
      ON CONFLICT (task_id, kind, item) DO UPDATE SET enabled = excluded.enabled`
  },
}
