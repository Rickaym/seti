import { DEFAULT_PROFILE_ID, reachesProvider, type GrantConnection, type ProviderId, type Task } from '@seti/shared'
import { grantConnections, taskConnections } from './connection-egress.js'
import { connectionRows, type ConnectionRow } from './store/connections.js'
import { profiles } from './store/credentials.js'

/** Whether a connection could carry the provider's key: a header on its hosts. */
const carriesKey = (provider: ProviderId) => (each: Pick<GrantConnection, 'header' | 'hosts'>) =>
  each.header !== null && reachesProvider(provider, each.hosts)

/**
 * The connection whose value is the agent's key for the provider, or null when it has none: one
 * of the agent's own connections that sets a header on the provider's hosts. Where a provider's
 * key attaches is decided here alone, so a grant takes the key from here and nowhere else.
 */
export async function providerKeyConnection(task: Task, provider: ProviderId): Promise<GrantConnection | null> {
  return grantConnections(await taskConnections(task)).find(carriesKey(provider)) ?? null
}

/** A connection that holds the provider's key: one above with a value set. */
const holdsKey = (provider: ProviderId) => (row: ConnectionRow) =>
  carriesKey(provider)(row) && Object.keys(row.slots).length > 0

/** Whether an agent on this credential would hold the provider's key. */
export const credentialHasKey = async (provider: ProviderId, profileId: string): Promise<boolean> =>
  (await connectionRows.ofProfile(profileId)).some(holdsKey(provider))

/** The credentials whose agents would hold the provider's key, for Settings; ids, never a value. */
export async function keyedCredentials(provider: ProviderId): Promise<string[]> {
  const ids = (await profiles.list()).map((profile) => profile.id)
  const keyed = await Promise.all(ids.map(async (id) => credentialHasKey(provider, id)))
  return ids.filter((_, i) => keyed[i] === true)
}

/**
 * The name of the one connection with the provider's key that the default credential does not
 * carry, or null when there is none or more than one; names only, for Settings to point at it.
 */
export async function keyOutsideDefault(provider: ProviderId): Promise<string | null> {
  const inDefault = new Set((await connectionRows.ofProfile(DEFAULT_PROFILE_ID)).map((row) => row.id))
  const outside = (await connectionRows.list()).filter((row) => holdsKey(provider)(row) && !inDefault.has(row.id))
  return outside.length === 1 ? (outside[0]?.name ?? null) : null
}
