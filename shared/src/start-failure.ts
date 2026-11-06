const PREFIX = "Couldn't start: "
const REASON_MAX = 120

/** The error of a session that could not start, which waits for the user instead of retrying. */
export const startFailure = (cause: string) => `${PREFIX}${cause}`

/** A start failure on one short line, or null for any other error. */
export function startFailureReason(error: string): string | null {
  if (!error.startsWith(PREFIX)) {
    return null
  }
  const line = error.split('\n', 1)[0] ?? ''
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 3).trimEnd()}...` : line
}
