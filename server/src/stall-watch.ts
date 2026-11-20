import { inBackground } from './background.js'
import { restartQuiet, sessionWatches, type SessionWatch } from './session-controls.js'
import { permissionRequests } from './store/permissions.js'
import { questions } from './store/questions.js'
import { setStall, stalledBy } from './task-blocked.js'
import { onAnyTaskEvent } from './task-events.js'

/** A running turn this long without a message of work is stuck, whatever it waits for. */
export const SILENT_MS = 20 * 60_000
const CHECK_MS = 60_000

const minutes = (ms: number) => `${String(Math.floor(ms / 60_000))} min`

/** Why the session looks stuck, or null while it works or rests. */
export function silentReason(session: SessionWatch, now: number, limit = SILENT_MS): string | null {
  const quiet = now - session.heardAt
  if (!session.running || quiet < limit) {
    return null
  }
  return session.retrying === null
    ? `No output for ${minutes(quiet)} while running`
    : `Claude API failing for ${minutes(quiet)}: ${session.retrying.replaceAll('_', ' ')}`
}

/** Whether the agent waits on the user's answer to a permission request or a question. */
const waitsOnAnswer = async (taskId: string): Promise<boolean> =>
  (await permissionRequests.pending(taskId)).length > 0 || (await questions.openList(taskId)).length > 0

/**
 * Marks each running session that went quiet too long, and clears the ones that spoke since. Time
 * a session waits on the user's answer is not silence, so its quiet clock starts over meanwhile.
 */
export async function checkSilentSessions(now = Date.now(), limit = SILENT_MS): Promise<void> {
  const live = new Map(sessionWatches())
  for (const [taskId, session] of live) {
    const waiting = await waitsOnAnswer(taskId)
    if (waiting) {
      restartQuiet(taskId, now)
    }
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
      restartQuiet(taskId)
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
