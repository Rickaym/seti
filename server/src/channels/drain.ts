import { pollerScheduler, pollerWorkers } from '../pollers/service.js'
import { stopReminderScripts } from '../reminders/sandbox.js'
import { reminderTicker } from '../reminders/service.js'

/** How long runs going at shutdown get to finish before Seti stops them. */
const FINISH_MS = 5000
/** How long a stopped run gets to note that it should run again after the restart. */
const NOTE_MS = 2000

const within = async (work: Promise<unknown>, ms: number) =>
  Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms).unref())])

const runsDone = async () => Promise.all([pollerScheduler.idle(), reminderTicker.idle()])

/**
 * Stops scheduling pollers and reminders as Seti shuts down. Runs going get a few seconds to
 * finish; the rest are stopped and run again after the restart, without counting as failures.
 */
export async function stopChannelRuns(): Promise<void> {
  pollerScheduler.stop()
  reminderTicker.stop()
  await within(runsDone(), FINISH_MS)
  stopReminderScripts()
  await pollerWorkers.close()
  await within(runsDone(), NOTE_MS)
}
