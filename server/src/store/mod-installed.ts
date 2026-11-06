import { modManifest, type ModCapability, type ModManifest } from '@seti/shared'
import { sql } from '../db.js'

/** A capability a mod holds at its running version, with the connection the user bound. */
interface GrantRow {
  capability: ModCapability
  connection_id: string | null
}

/** Installed mods as they run now: the version their install points at, while they are on. */
export const installedMods = {
  /** The grants of the running version; empty when the mod is off or not installed. */
  grants: async (modId: string): Promise<GrantRow[]> =>
    sql<GrantRow[]>`SELECT g.capability, g.connection_id FROM mod_grant g
      JOIN mod_install i ON i.mod_id = g.mod_id AND i.current_hash = g.hash
      JOIN mod_state s ON s.mod_id = g.mod_id AND s.enabled
      WHERE g.mod_id = ${modId} ORDER BY g.idx`,
  /** The manifest of the running version; null when the mod is off or not installed. */
  manifest: async (modId: string): Promise<ModManifest | null> => {
    const [row] = await sql<{ manifest: unknown }[]>`SELECT v.manifest FROM mod_version v
      JOIN mod_install i ON i.mod_id = v.mod_id AND i.current_hash = v.hash
      JOIN mod_state s ON s.mod_id = v.mod_id AND s.enabled
      WHERE v.mod_id = ${modId}`
    return row === undefined ? null : modManifest.parse(row.manifest)
  },
}
