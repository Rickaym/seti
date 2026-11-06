import { randomBytes } from 'node:crypto'
import { NAMED_SECRET_PREFIX, type AuditDetail } from '@seti/shared'
import type { Db } from '../pg.js'
import { planConnections, type OldRule, type OldSecret, type PlannedConnection } from './connection-plan.js'

/**
 * One connection per service an agent reaches: its hosts, kind, placeholder variable, optional
 * header and mint settings. Its values are sealed secret rows, by slot; credentials carry it.
 * The tables it replaces stay as they were, so the version before still finds its data.
 */
export const CONNECTIONS = `
CREATE TABLE connection (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('key', 'client_credentials', 'refresh_token', 'jwt_bearer')),
  env TEXT NOT NULL UNIQUE,
  placeholder TEXT NOT NULL UNIQUE,
  hosts TEXT[] NOT NULL,
  header TEXT,
  template TEXT,
  mint JSONB,
  mint_error TEXT,
  mint_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE connection_secret (
  connection_id TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  secret TEXT NOT NULL REFERENCES secret(name) ON DELETE CASCADE,
  PRIMARY KEY (connection_id, slot)
);
CREATE INDEX connection_secret_secret ON connection_secret(secret);

CREATE TABLE credential_profile_connection (
  profile_id TEXT NOT NULL REFERENCES credential_profile(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, connection_id)
);
CREATE INDEX credential_profile_connection_connection ON credential_profile_connection(connection_id);
`

const placeholderFor = (name: string) => `seti-secret-${name}-${randomBytes(16).toString('hex')}`

async function readOld(tx: Db) {
  const secrets = await tx<OldSecret[]>`SELECT substr(name, ${NAMED_SECRET_PREFIX.length + 1}) AS name, env, hosts,
      placeholder FROM secret WHERE starts_with(name, ${NAMED_SECRET_PREFIX}) ORDER BY name`
  const grants = await tx<{ profile_id: string; secret: string }[]>`SELECT profile_id,
      substr(secret, ${NAMED_SECRET_PREFIX.length + 1}) AS secret FROM credential_profile_secret
    ORDER BY profile_id, secret`
  const rules = await tx<OldRule[]>`SELECT profile_id, kind, hosts, header, template, secret, minter, mint_error,
      mint_checked_at FROM credential_rule ORDER BY profile_id, position`
  const pollers = await tx<{ secrets: string }[]>`SELECT secrets FROM channel_poller`
  const pollerRefs = pollers.flatMap((row) => {
    const parsed: unknown = JSON.parse(row.secrets)
    return Array.isArray(parsed) ? parsed.filter((ref): ref is string => typeof ref === 'string') : []
  })
  return { secrets: [...secrets], grants: [...grants], rules: [...rules], pollerRefs }
}

async function insertConnection(tx: Db, connection: PlannedConnection, at: string): Promise<void> {
  const id = randomBytes(16).toString('hex')
  await tx`INSERT INTO connection (id, name, kind, env, placeholder, hosts, header, template, mint, mint_error,
      mint_checked_at, created_at, updated_at)
    VALUES (${id}, ${connection.name}, ${connection.kind}, ${connection.env}, ${connection.placeholder},
      ${connection.hosts}, ${connection.header?.name ?? null}, ${connection.header?.template ?? null},
      ${connection.mint === null ? null : tx.json(connection.mint)}, ${connection.mint_error},
      ${connection.mint_checked_at}, ${at}, ${at})`
  for (const [slot, secret] of Object.entries(connection.slots)) {
    const stored = NAMED_SECRET_PREFIX + secret
    await tx`INSERT INTO connection_secret (connection_id, slot, secret) VALUES (${id}, ${slot}, ${stored})`
  }
  for (const profile of connection.profiles) {
    await tx`INSERT INTO credential_profile_connection (profile_id, connection_id) VALUES (${profile}, ${id})`
  }
}

const line = (connection: PlannedConnection) => {
  const hosts = connection.hosts.length === 0 ? 'no hosts' : connection.hosts.join(' ')
  return `${connection.name} (${connection.kind}, ${connection.env}) on ${hosts} from ${connection.from}`
}

/** Moves API keys, header rules and named secrets onto connections, reading no secret value. */
export async function secretsToConnections(tx: Db): Promise<void> {
  const planned = planConnections(await readOld(tx), placeholderFor)
  const at = new Date().toISOString()
  for (const connection of planned) {
    await insertConnection(tx, connection, at)
  }
  if (planned.length === 0) {
    return
  }
  const summary = `Moved ${String(planned.length)} API keys, header rules and named secrets onto connections`
  const detail: AuditDetail = { connections: planned.map(line) }
  await tx`INSERT INTO audit_event (at, actor, kind, subject_type, subject_id, summary, detail)
    VALUES (${at}, 'system', 'system.connections_migrated', 'system', NULL, ${summary}, ${JSON.stringify(detail)})`
}
