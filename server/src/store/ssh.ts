import type { SshKeySource, SshKnownHost, SshOption } from '@seti/shared'
import { now, sql, transaction } from '../db.js'

/** A host as stored: its facts, user and key, without the defaults, routes and sets the views add. */
export interface SshHostRow {
  alias: string
  hostname: string
  port: number
  user: string
  key_id: string | null
  jump: string | null
  options: SshOption[]
  created_at: string
  updated_at: string
}

export type SshHostFacts = Pick<SshHostRow, 'hostname' | 'port' | 'user' | 'key_id' | 'jump' | 'options'>

const HOST_COLUMNS = sql`alias, hostname, port, username AS user, key_id, jump, options, created_at, updated_at`

const optionsJson = (options: readonly SshOption[]) => sql.json(options.map((option) => ({ ...option })))

export const sshHostStore = {
  list: async (): Promise<SshHostRow[]> =>
    sql<SshHostRow[]>`SELECT ${HOST_COLUMNS} FROM ssh_host ORDER BY lower(alias), alias`,
  get: async (alias: string): Promise<SshHostRow | undefined> => {
    const [row] = await sql<SshHostRow[]>`SELECT ${HOST_COLUMNS} FROM ssh_host WHERE alias = ${alias}`
    return row
  },
  insert: async (alias: string, facts: SshHostFacts): Promise<void> => {
    const at = now()
    await sql`INSERT INTO ssh_host (alias, hostname, port, username, key_id, jump, options, created_at, updated_at)
      VALUES (${alias}, ${facts.hostname}, ${facts.port}, ${facts.user}, ${facts.key_id}, ${facts.jump},
        ${optionsJson(facts.options)}, ${at}, ${at})`
  },
  update: async (alias: string, facts: SshHostFacts): Promise<void> => {
    await sql`UPDATE ssh_host SET hostname = ${facts.hostname}, port = ${facts.port}, username = ${facts.user},
      key_id = ${facts.key_id}, jump = ${facts.jump}, options = ${optionsJson(facts.options)}, updated_at = ${now()}
      WHERE alias = ${alias}`
  },
  /** Moves a host and everything naming it to `next`; returns the sets that bundle it. */
  rename: async (alias: string, next: string): Promise<string[]> =>
    transaction(async (tx) => {
      await tx`INSERT INTO ssh_host (alias, hostname, port, username, key_id, jump, options, created_at, updated_at)
        SELECT ${next}, hostname, port, username, key_id, jump, options, created_at, ${now()}
        FROM ssh_host WHERE alias = ${alias}`
      await tx`UPDATE ssh_host SET jump = ${next} WHERE jump = ${alias}`
      await tx`UPDATE credential_profile_ssh_host SET host = ${next} WHERE host = ${alias}`
      await tx`UPDATE access_default SET item = ${next} WHERE kind = 'ssh' AND item = ${alias}`
      await tx`UPDATE task_access SET item = ${next} WHERE kind = 'ssh' AND item = ${alias}`
      await tx`DELETE FROM ssh_host WHERE alias = ${alias}`
      const sets = await tx<{ name: string }[]>`SELECT p.name FROM credential_profile_ssh_host s
        JOIN credential_profile p ON p.id = s.profile_id WHERE s.host = ${next} ORDER BY lower(p.name)`
      return sets.map((row) => row.name)
    }),
  /** Deletes a host with every agent's choice for it; returns the sets that bundled it. */
  delete: async (alias: string): Promise<string[]> =>
    transaction(async (tx) => {
      const sets = await tx<{ name: string }[]>`SELECT p.name FROM credential_profile_ssh_host s
        JOIN credential_profile p ON p.id = s.profile_id WHERE s.host = ${alias} ORDER BY lower(p.name)`
      await tx`DELETE FROM access_default WHERE kind = 'ssh' AND item = ${alias}`
      await tx`DELETE FROM task_access WHERE kind = 'ssh' AND item = ${alias}`
      await tx`DELETE FROM ssh_host WHERE alias = ${alias}`
      return sets.map((row) => row.name)
    }),
}

/** A host a credential bundles, with the set's name for views and audit lines. */
export interface SetHostRow {
  profile_id: string
  profile_name: string
  host: string
}

/** Which hosts each credential bundles, so every agent using the set gets them. */
export const setHosts = {
  list: async (): Promise<SetHostRow[]> =>
    sql<SetHostRow[]>`SELECT s.profile_id, p.name AS profile_name, s.host FROM credential_profile_ssh_host s
      JOIN credential_profile p ON p.id = s.profile_id ORDER BY (s.profile_id = 'default') DESC, lower(p.name)`,
  forProfile: async (profileId: string): Promise<string[]> =>
    (
      await sql<{ host: string }[]>`SELECT host FROM credential_profile_ssh_host WHERE profile_id = ${profileId}
        ORDER BY lower(host), host`
    ).map((row) => row.host),
  add: async (profileId: string, host: string): Promise<boolean> =>
    (
      await sql`INSERT INTO credential_profile_ssh_host (profile_id, host, created_at)
        VALUES (${profileId}, ${host}, ${now()}) ON CONFLICT DO NOTHING RETURNING host`
    ).length > 0,
  remove: async (profileId: string, host: string): Promise<boolean> =>
    (
      await sql`DELETE FROM credential_profile_ssh_host WHERE profile_id = ${profileId} AND host = ${host}
      RETURNING host`
    ).length > 0,
}

/** A key as stored: its public half and, for a key file, where the private half is read from. */
export interface SshKeyRow {
  id: string
  name: string
  type: string
  public_key: string
  fingerprint: string
  source: SshKeySource
  path: string | null
  created_at: string
  updated_at: string
}

export type SshKeyMaterial = Pick<SshKeyRow, 'type' | 'public_key' | 'fingerprint' | 'source' | 'path'>

const KEY_COLUMNS = sql`id, name, type, public_key, fingerprint, source, path, created_at, updated_at`

/** The ssh keys hosts select, public halves only; private keys are sealed in the secret store. */
export const sshKeys = {
  list: async (): Promise<SshKeyRow[]> => sql<SshKeyRow[]>`SELECT ${KEY_COLUMNS} FROM ssh_key ORDER BY created_at, id`,
  get: async (id: string): Promise<SshKeyRow | undefined> => {
    const [row] = await sql<SshKeyRow[]>`SELECT ${KEY_COLUMNS} FROM ssh_key WHERE id = ${id}`
    return row
  },
  insert: async (key: SshKeyRow): Promise<void> => {
    await sql`INSERT INTO ssh_key (id, name, type, public_key, fingerprint, source, path, created_at, updated_at)
      VALUES (${key.id}, ${key.name}, ${key.type}, ${key.public_key}, ${key.fingerprint}, ${key.source}, ${key.path},
        ${key.created_at}, ${key.updated_at})`
  },
  rename: async (id: string, name: string): Promise<void> => {
    await sql`UPDATE ssh_key SET name = ${name}, updated_at = ${now()} WHERE id = ${id}`
  },
  replace: async (id: string, material: SshKeyMaterial): Promise<void> => {
    await sql`UPDATE ssh_key SET type = ${material.type}, public_key = ${material.public_key},
      fingerprint = ${material.fingerprint}, source = ${material.source}, path = ${material.path},
      updated_at = ${now()} WHERE id = ${id}`
  },
  delete: async (id: string): Promise<boolean> =>
    (await sql`DELETE FROM ssh_key WHERE id = ${id} RETURNING id`).length > 0,
}

export type KnownHostRow = SshKnownHost & { public_key: string }

/** Host keys the user accepted; a sandbox trusts those of its own ssh hosts. */
export const sshKnownHosts = {
  list: async (): Promise<KnownHostRow[]> =>
    sql<KnownHostRow[]>`SELECT host, key_type, public_key, fingerprint, accepted_at FROM ssh_known_host
      ORDER BY host, key_type`,
  put: async (row: Omit<KnownHostRow, 'accepted_at'>): Promise<void> => {
    await sql`INSERT INTO ssh_known_host (host, key_type, public_key, fingerprint, accepted_at)
      VALUES (${row.host}, ${row.key_type}, ${row.public_key}, ${row.fingerprint}, ${now()})
      ON CONFLICT (host, key_type) DO UPDATE SET public_key = excluded.public_key,
        fingerprint = excluded.fingerprint, accepted_at = excluded.accepted_at`
  },
  deleteHost: async (host: string): Promise<number> =>
    (await sql`DELETE FROM ssh_known_host WHERE host = ${host} RETURNING host`).length,
}
