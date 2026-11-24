import { hostMatches, type GrantConnection, type Task } from '@seti/shared'
import { grantConnections, taskConnections } from './connection-egress.js'
import { connectionRows } from './store/connections.js'

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

/** How many of the user's connections could carry the key, for Settings; never a value. */
export const codexKeyCount = async (): Promise<number> => (await connectionRows.list()).filter(carriesKey).length
