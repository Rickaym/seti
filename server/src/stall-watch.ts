import { inBackground } from './background.js'
import { controlLink } from './node-link.js'
import { permissionRequests } from './store/permissions.js'
import { questions } from './store/questions.js'
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

/** Whether the agent waits on the user's answer to a permission request or a question. */
const waitsOnAnswer = async (taskId: string): Promise<boolean> =>
  (await permissionRequests.pending(taskId)).length > 0 || (await questions.openList(taskId)).length > 0

/**
 * Marks each running session that went quiet too long, and clears the ones that spoke since. Time
 * a session waits on the user's answer is not silence, so its quiet clock starts over meanwhile.
 */
export async function checkSilentSessions(now = Date.now(), limit = SILENT_MS): Promise<void> {
  const { sessions } = await controlLink.command('sessions.view', {})
  for (const session of sessions) {
    const waiting = await waitsOnAnswer(session.agent)
    if (waiting) {
      await controlLink.command('quiet.restart', { agent: session.agent, at: now })
    }
    await setStall(session.agent, 'silent', waiting ? null : silentReason(session, now, limit))
  }
  const open = new Set(sessions.map((session) => session.agent))
  for (const taskId of stalledBy('silent').filter((id) => !open.has(id))) {
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
      inBackground('stall watch', async () => controlLink.command('quiet.restart', { agent: taskId, at: null }))
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
