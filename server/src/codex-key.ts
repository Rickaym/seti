import { hostMatches, type GrantConnection, type Task } from '@seti/shared'
import { grantConnections, taskConnections } from './connection-egress.js'
import { connectionRows } from './store/connections.js'
import { profiles } from './store/credentials.js'

/** The host a Codex agent sends its model calls to. */
const OPENAI_HOST = 'api.openai.com'

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
  each.header !== null && each.hosts.some((pattern) => hostMatches(pattern, OPENAI_HOST))

/** Whether an agent on this credential would hold an OpenAI key: one above with a value set. */
export const credentialHasKey = async (profileId: string): Promise<boolean> =>
  (await connectionRows.ofProfile(profileId)).some((row) => carriesKey(row) && Object.keys(row.slots).length > 0)

/** The credentials whose agents would hold an OpenAI key, for Settings; ids, never a value. */
export async function codexKeyedCredentials(): Promise<string[]> {
  const ids = (await profiles.list()).map((profile) => profile.id)
  const keyed = await Promise.all(ids.map(credentialHasKey))
  return ids.filter((_, i) => keyed[i] === true)
}
