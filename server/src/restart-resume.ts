import { audit } from './audit.js'
import { tasks } from './db.js'
import { notifyTurnEnd } from './notifications.js'
import { runTurn } from './runner.js'
import { archiveSettings } from './store/archive.js'

export const RESUME_PROMPT =
  'Seti restarted while your last turn ran. Check what finished before the cut, without repeating ' +
  'any step that may already have run, then continue.'

/** The gap between resumes, so the sessions a restart cut off do not all start together. */
const RESUME_STAGGER_MS = 2000

const pause = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })

/**
 * Marks the turns a restart cut off. With Resume after restart on, those that waited on nothing
 * and are not archived are to resume; the rest need the user.
 */
export async function markRestartCut(): Promise<{ notify: string[]; resume: string[] }> {
  const cut = await tasks.markInterrupted((await archiveSettings.get()).resume_after_restart)
  return {
    notify: cut.filter((task) => !task.resume).map((task) => task.id),
    resume: cut.filter((task) => task.resume).map((task) => task.id),
  }
}

/** Sends the agent the resume message in its own session, unless the user got to it first. */
async function resumeOne(taskId: string): Promise<void> {
  const task = await tasks.get(taskId)
  if (task?.status !== 'interrupted' || task.archived_at !== null) {
    return
  }
  try {
    await runTurn(taskId, RESUME_PROMPT, { from: 'Seti' })
  } catch (e) {
    const why = `Could not resume after the restart: ${e instanceof Error ? e.message : String(e)}`
    await tasks.endTurn(taskId, {
      status: 'interrupted',
      last_error: why,
      asking: false,
      closing_line: task.closing_line,
    })
    notifyTurnEnd(taskId, 'interrupted')
    throw e
  }
  await audit.record({
    actor: 'system',
    kind: 'task.resumed_after_restart',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Resumed task "${task.title}" after a restart`,
    detail: { title: task.title, prompt: RESUME_PROMPT },
  })
}

/** Resumes each agent a restart cut off once, one at a time, `staggerMs` apart. */
export async function resumeInterrupted(taskIds: readonly string[], staggerMs = RESUME_STAGGER_MS): Promise<void> {
  for (const [index, taskId] of [...new Set(taskIds)].entries()) {
    if (index > 0) {
      await pause(staggerMs)
    }
    try {
      await resumeOne(taskId)
    } catch (e) {
      process.stderr.write(`resume: task ${taskId}: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
}
