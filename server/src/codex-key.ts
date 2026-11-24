import { CODEX_MODEL_HOST, DEFAULT_PROFILE_ID, hostMatches, type GrantConnection, type Task } from '@seti/shared'
import { grantConnections, taskConnections } from './connection-egress.js'
import { connectionRows, type ConnectionRow } from './store/connections.js'
import { profiles } from './store/credentials.js'

/**
 * The connection whose value is a Codex agent's OpenAI key, or null when it has none: one of the
 * agent's own connections that sets a header on OpenAI's API. Where the key attaches is decided
 * here alone, so a Codex agent's grant takes the key from this function and nowhere else.
 */
export async function codexKeyConnection(task: Task): Promise<GrantConnection | null> {
  return grantConnections(await taskConnections(task)).find(carriesKey) ?? null
}

/** Whether a connection could carry a Codex agent's OpenAI key: a header on OpenAI's API. */
const carriesKey = (each: Pick<GrantConnection, 'header' | 'hosts'>) =>
  each.header !== null && each.hosts.some((pattern) => hostMatches(pattern, CODEX_MODEL_HOST))

/** A connection that holds an OpenAI key: one above with a value set. */
const holdsKey = (row: ConnectionRow) => carriesKey(row) && Object.keys(row.slots).length > 0

/** Whether an agent on this credential would hold an OpenAI key. */
export const credentialHasKey = async (profileId: string): Promise<boolean> =>
  (await connectionRows.ofProfile(profileId)).some(holdsKey)

/** The credentials whose agents would hold an OpenAI key, for Settings; ids, never a value. */
export async function codexKeyedCredentials(): Promise<string[]> {
  const ids = (await profiles.list()).map((profile) => profile.id)
  const keyed = await Promise.all(ids.map(credentialHasKey))
  return ids.filter((_, i) => keyed[i] === true)
}

/**
 * The name of the one connection with an OpenAI key that the default credential does not carry,
 * or null when there is none or more than one; names only, for Settings to point at it.
 */
export async function keyOutsideDefault(): Promise<string | null> {
  const inDefault = new Set((await connectionRows.ofProfile(DEFAULT_PROFILE_ID)).map((row) => row.id))
  const outside = (await connectionRows.list()).filter((row) => holdsKey(row) && !inDefault.has(row.id))
  return outside.length === 1 ? (outside[0]?.name ?? null) : null
}
