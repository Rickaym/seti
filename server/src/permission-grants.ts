import { createHash } from 'node:crypto'

/** How long an answer given after a restart waits for the agent to make the call again. */
const GRANT_MS = 15 * 60 * 1000

/** When each one-time grant runs out, by task and call hash. */
const grants = new Map<string, number>()

/** The value as JSON with every object's keys in order, so equal calls read the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, inner]) => [key, canonical(inner)]),
    )
  }
  return value
}

/** A hash of the exact call: the tool and its whole input. It names the call, never shows it. */
export const callHash = (tool: string, input: Record<string, unknown>): string =>
  createHash('sha256')
    .update(JSON.stringify([tool, canonical(input)]))
    .digest('hex')

const keyOf = (taskId: string, hash: string) => `${taskId}:${hash}`

/** Lets the agent make the one call the user allowed after a restart, once, without asking again. */
export function grantOnce(taskId: string, hash: string, at = Date.now()): void {
  grants.set(keyOf(taskId, hash), at + GRANT_MS)
}

/** Uses up the grant for the call; false when the user allowed no such call or it ran out. */
export function takeGrant(taskId: string, hash: string, at = Date.now()): boolean {
  const key = keyOf(taskId, hash)
  const until = grants.get(key)
  grants.delete(key)
  return until !== undefined && at <= until
}
