import { inBackground } from './background.js'
import { liveSessions } from './runner.js'
import { permissionRequests } from './store/permissions.js'
import { setStall, stalledBy } from './task-blocked.js'
import { onAnyTaskEvent } from './task-events.js'

/** A running turn this long without a message of work is stuck, whatever it waits for. */
export const SILENT_MS = 20 * 60_000
const CHECK_MS = 60_000

const minutes = (ms: number) => `${String(Math.floor(ms / 60_000))} min`

/** What a running session looks like to the watchdog. */
export interface Watched {
  running: boolean
  heardAt: number
  retrying: string | null
}

/** Why the session looks stuck, or null while it works or rests. */
export function silentReason(session: Watched, now: number, limit = SILENT_MS): string | null {
  const quiet = now - session.heardAt
  if (!session.running || quiet < limit) {
    return null
  }
  return session.retrying === null
    ? `No output for ${minutes(quiet)} while running`
    : `Claude API failing for ${minutes(quiet)}: ${session.retrying.replaceAll('_', ' ')}`
}

/** Marks each running session that went quiet too long, and clears the ones that spoke since. */
export async function checkSilentSessions(now = Date.now(), limit = SILENT_MS): Promise<void> {
  const live = new Map(liveSessions())
  for (const [taskId, session] of live) {
    const waiting = (await permissionRequests.pending(taskId)).length > 0
    await setStall(taskId, 'silent', waiting ? null : silentReason(session, now, limit))
  }
  for (const taskId of stalledBy('silent').filter((id) => !live.has(id))) {
    await setStall(taskId, 'silent', null)
  }
}

/**
 * An answered or dropped request restarts the quiet clock: the session waited on the user, not
 * on itself, so the time it held the request is not silence.
 */
export function restartQuietOnAnswer(): void {
  onAnyTaskEvent((taskId, event) => {
    if (event.type === 'permission' && event.request.state !== 'pending') {
      liveSessions()
        .find(([id]) => id === taskId)?.[1]
        .restartQuiet()
    }
  })
}

/** Looks at every open session once a minute. */
export function watchSilentSessions(): void {
  const timer = setInterval(() => {
    inBackground('stall watch', async () => checkSilentSessions())
  }, CHECK_MS)
  timer.unref()
}
