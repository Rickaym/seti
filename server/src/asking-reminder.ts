import { inBackground } from './background.js'
import { tasks } from './db.js'
import { remindAsking } from './notifications.js'

/** How long a question an agent asked in its reply waits before Seti reminds the user, once. */
export const ASKING_REMINDER_MS = 15 * 60_000

const timers = new Map<string, NodeJS.Timeout>()

function disarm(taskId: string): void {
  clearTimeout(timers.get(taskId))
  timers.delete(taskId)
}

/** Reminds unless the agent was answered or changed since its turn ended at `endedAt`. */
async function remind(taskId: string, endedAt: string): Promise<void> {
  const task = await tasks.get(taskId)
  if (task !== undefined && task.asking && task.updated_at === endedAt) {
    await remindAsking(task)
  }
}

/** Arms the one reminder of a turn that ended asking at `endedAt`; none when that time passed. */
function arm(taskId: string, endedAt: string, now: number): void {
  disarm(taskId)
  const wait = Date.parse(endedAt) + ASKING_REMINDER_MS - now
  if (wait <= 0) {
    return
  }
  const timer = setTimeout(() => {
    timers.delete(taskId)
    inBackground('asking reminder', async () => remind(taskId, endedAt))
  }, wait)
  timer.unref()
  timers.set(taskId, timer)
}

/** Turn-end listener: a turn that ended asking gets its reminder; any other end drops it. */
export async function remindWhenAsking(taskId: string): Promise<void> {
  const task = await tasks.get(taskId)
  if (task?.asking === true) {
    arm(taskId, task.updated_at, Date.now())
  } else {
    disarm(taskId)
  }
}

/**
 * Startup: arms the reminders a restart dropped, each for the rest of its wait. A question older
 * than the wait gets none, so a restart never reminds a second time.
 */
export async function rearmAskingReminders(now = Date.now()): Promise<void> {
  for (const task of await tasks.list()) {
    if (task.asking) {
      arm(task.id, task.updated_at, now)
    }
  }
}
