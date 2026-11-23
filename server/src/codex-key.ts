import { hostMatches, type GrantConnection, type Task } from '@seti/shared'
import { grantConnections, taskConnections } from './connection-egress.js'

/** The host a Codex agent sends its model calls to. */
export const OPENAI_HOST = 'api.openai.com'

/**
 * The connection whose value is a Codex agent's OpenAI key, or null when it has none: one of the
 * agent's own connections that sets a header on OpenAI's API. Where the key attaches is decided
 * here alone, so a Codex agent's grant takes the key from this function and nowhere else.
 */
export async function codexKeyConnection(task: Task): Promise<GrantConnection | null> {
  const granted = grantConnections(await taskConnections(task))
  const covers = (each: GrantConnection) => each.hosts.some((pattern) => hostMatches(pattern, OPENAI_HOST))
  return granted.find((each) => each.header !== null && covers(each)) ?? null
}
