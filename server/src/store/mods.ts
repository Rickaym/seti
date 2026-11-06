import { now, sql, transaction } from '../db.js'

/** One value of a mod's store at most, and all of one mod's values together. */
const MOD_DATA_VALUE_MAX = 64 * 1024
const MOD_DATA_TOTAL_MAX = 1024 * 1024
export const MOD_DATA_KEY_MAX = 200

/** A value the store refuses: too large, or not JSON. */
export class ModDataFull extends Error {}

export const modHostSettings = {
  safeMode: async (): Promise<boolean> =>
    (await sql<{ safe_mode: boolean }[]>`SELECT safe_mode FROM mod_host WHERE id = 1`).at(0)?.safe_mode ?? false,
  setSafeMode: async (safeMode: boolean): Promise<void> => {
    await sql`INSERT INTO mod_host (id, safe_mode, updated_at) VALUES (1, ${safeMode}, ${now()})
      ON CONFLICT (id) DO UPDATE SET safe_mode = excluded.safe_mode, updated_at = excluded.updated_at`
  },
}

export const modStates = {
  /** Each mod the user turned on or off; a mod missing here keeps its manifest's default. */
  all: async (): Promise<Map<string, boolean>> =>
    new Map(
      (await sql<{ mod_id: string; enabled: boolean }[]>`SELECT mod_id, enabled FROM mod_state`).map((row) => [
        row.mod_id,
        row.enabled,
      ]),
    ),
  set: async (modId: string, enabled: boolean): Promise<void> => {
    await sql`INSERT INTO mod_state (mod_id, enabled, updated_at) VALUES (${modId}, ${enabled}, ${now()})
      ON CONFLICT (mod_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  },
}

export const modSettings = {
  get: async (modId: string): Promise<Record<string, unknown>> =>
    Object.fromEntries(
      (await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM mod_settings WHERE mod_id = ${modId}`).map(
        (row) => [row.key, row.value],
      ),
    ),
  /** Saves the given keys in one go; the caller validated them against the manifest. */
  put: async (modId: string, values: Readonly<Record<string, unknown>>): Promise<void> => {
    const at = now()
    await transaction(async (tx) => {
      for (const [key, value] of Object.entries(values)) {
        await tx`INSERT INTO mod_settings (mod_id, key, value, updated_at)
          VALUES (${modId}, ${key}, ${JSON.stringify(value)}::text::jsonb, ${at})
          ON CONFLICT (mod_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      }
    })
  },
}

export const modNotifications = {
  /** The kinds of a mod the user switched, by kind; the rest keep the manifest's default. */
  get: async (modId: string): Promise<Map<string, boolean>> =>
    new Map(
      (
        await sql<{ kind: string; enabled: boolean }[]>`SELECT kind, enabled FROM mod_notification
          WHERE mod_id = ${modId}`
      ).map((row) => [row.kind, row.enabled]),
    ),
  put: async (modId: string, kinds: Readonly<Record<string, boolean>>): Promise<void> => {
    const at = now()
    await transaction(async (tx) => {
      for (const [kind, enabled] of Object.entries(kinds)) {
        await tx`INSERT INTO mod_notification (mod_id, kind, enabled, updated_at)
          VALUES (${modId}, ${kind}, ${enabled}, ${at})
          ON CONFLICT (mod_id, kind) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
      }
    })
  },
}

export const modData = {
  get: async (modId: string, key: string): Promise<unknown> =>
    (await sql<{ value: unknown }[]>`SELECT value FROM mod_data WHERE mod_id = ${modId} AND key = ${key}`).at(0)
      ?.value ?? null,
  keys: async (modId: string): Promise<string[]> =>
    (await sql<{ key: string }[]>`SELECT key FROM mod_data WHERE mod_id = ${modId} ORDER BY key`).map((row) => row.key),
  /** Stores the value; throws ModDataFull past the per-value or per-mod cap. */
  set: async (modId: string, key: string, value: unknown): Promise<void> => {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      throw new ModDataFull('A stored value is JSON: text, numbers, true, false, null, lists and objects')
    }
    const text = JSON.stringify(value)
    const bytes = Buffer.byteLength(text)
    if (bytes > MOD_DATA_VALUE_MAX) {
      throw new ModDataFull(`A stored value is at most ${String(MOD_DATA_VALUE_MAX / 1024)} KB`)
    }
    const lock = `mod_data:${modId}`
    await transaction(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${lock}))`
      const [row] = await tx<{ total: number }[]>`SELECT COALESCE(SUM(bytes), 0)::int AS total FROM mod_data
        WHERE mod_id = ${modId} AND key <> ${key}`
      if ((row?.total ?? 0) + bytes > MOD_DATA_TOTAL_MAX) {
        throw new ModDataFull(`A mod stores at most ${String(MOD_DATA_TOTAL_MAX / 1024 / 1024)} MB`)
      }
      await tx`INSERT INTO mod_data (mod_id, key, value, bytes, updated_at)
        VALUES (${modId}, ${key}, ${text}::text::jsonb, ${bytes}, ${now()})
        ON CONFLICT (mod_id, key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes,
          updated_at = excluded.updated_at`
    })
  },
  delete: async (modId: string, key: string): Promise<void> => {
    await sql`DELETE FROM mod_data WHERE mod_id = ${modId} AND key = ${key}`
  },
}
