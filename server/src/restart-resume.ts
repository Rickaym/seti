import { audit } from './audit.js'
import { tasks } from './db.js'
import { notifyTurnEnd } from './notifications.js'
import { appendMessage, runTurn } from './runner.js'
import { archiveSettings } from './store/archive.js'
import { restartCuts, type CutKind } from './store/restart.js'
import { refreshBlocked } from './task-blocked.js'
import { inLane } from './task-lane.js'

export const RESUME_PROMPT =
  'Seti restarted while you were working. Continue where you left off; check the state of anything ' +
  'you had running before repeating it.'

/** Added for an agent that had background work, which stops with its process. */
export const BACKGROUND_NOTE =
  'The background commands and subagents you had started were stopped by the restart; start again ' +
  'any you still need.'

/** The transcript's mark on a turn Seti resumed. */
export const RESUMED_NOTE = 'Seti restarted during this turn and resumed it'

/** After this many resumes with no turn finished in between, startup leaves the agent alone. */
export const RESUME_LIMIT = 3
/** How far back resumes count towards the limit. */
export const RESUME_WINDOW_MS = 30 * 60 * 1000

export const HELD_REASON =
  `Not resumed: restarts cut it off ${String(RESUME_LIMIT)} times in ` +
  `${String(RESUME_WINDOW_MS / 60_000)} minutes before it finished a turn`

/** How resumes are spread out, so a restart does not start every cut session at once. */
export interface ResumePace {
  /** How many sessions start close together. */
  group: number
  /** The gap between two starts of a group. */
  staggerMs: number
  /** The gap before the next group. */
  groupGapMs: number
  /** Waits out a gap; tests pass their own. */
  wait?: (ms: number) => Promise<void>
}

const PACE: ResumePace = { group: 3, staggerMs: 2000, groupGapMs: 20_000 }

/** An agent startup resumes: what its last stop recorded, or null after a crash. */
export interface Resume {
  taskId: string
  kind: CutKind | null
  background: number
}

/** What the agent is told when it resumes; background work is named only if it had any. */
const resumeText = (background: number) => (background > 0 ? `${RESUME_PROMPT} ${BACKGROUND_NOTE}` : RESUME_PROMPT)

const pause = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })

/** Turns the user waits on go first, then those background work started, then updates. */
const ORDER: Record<CutKind, number> = { user: 0, wake: 1, updates: 2 }

const windowStart = (at: number) => new Date(at - RESUME_WINDOW_MS).toISOString()

/** Leaves an agent that restarts keep cutting off for the user, with the reason on its row. */
async function hold(taskId: string): Promise<void> {
  await restartCuts.hold(taskId, HELD_REASON)
  const title = (await tasks.get(taskId))?.title ?? taskId
  await audit.record({
    actor: 'system',
    kind: 'task.resume_held',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Did not resume task "${title}" again: ${String(RESUME_LIMIT)} resumes without a finished turn`,
    detail: { title, resumes: RESUME_LIMIT, window_minutes: RESUME_WINDOW_MS / 60_000 },
  })
}

/**
 * Marks the turns a restart cut off and picks those to resume. With Resume after restart on, an
 * agent resumes unless it is archived, still waits on the user's answer to a question or a
 * permission request, or was resumed too often without finishing a turn. Those left for the user
 * are in `notify`, except the ones that wait on an answer, which the user was told about before.
 */
export async function markRestartCut(at = Date.now()): Promise<{ notify: string[]; resume: Resume[] }> {
  const recorded = await restartCuts.recorded()
  const { resume_after_restart: on } = await archiveSettings.get()
  const cut = await tasks.markInterrupted()
  const notify: string[] = []
  const resume: Resume[] = []
  for (const task of cut.filter((each) => !each.waits)) {
    if (!on || task.archived) {
      notify.push(task.id)
    } else if ((await restartCuts.resumes(task.id, windowStart(at))) >= RESUME_LIMIT) {
      await hold(task.id)
      notify.push(task.id)
    } else {
      const turn = recorded.get(task.id)
      resume.push({ taskId: task.id, kind: turn?.kind ?? null, background: turn?.background ?? 0 })
    }
  }
  await restartCuts.markResuming(resume.map((each) => each.taskId))
  await restartCuts.forget(cut.filter((task) => task.waits).map((task) => task.id))
  for (const id of new Set([...(await restartCuts.blockedIds()), ...cut.map((task) => task.id)])) {
    await refreshBlocked(id)
  }
  resume.sort((a, b) => ORDER[a.kind ?? 'user'] - ORDER[b.kind ?? 'user'])
  return { notify, resume }
}

/** Sends the agent the resume message in its own session, unless the user got to it first. */
async function resumeOne({ taskId, kind, background }: Resume, at: number): Promise<void> {
  const task = await tasks.get(taskId)
  if (task?.status !== 'interrupted' || task.archived_at !== null) {
    return
  }
  const prompt = resumeText(background)
  try {
    await inLane(taskId, async () =>
      appendMessage(taskId, { kind: 'seti', payload: { error: RESUMED_NOTE, resumed: true } }),
    )
    await runTurn(taskId, prompt, { from: 'Seti' })
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
  await restartCuts.countResume(taskId, windowStart(at))
  await audit.record({
    actor: 'system',
    kind: 'task.resumed_after_restart',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Resumed task "${task.title}" after a restart`,
    detail: { title: task.title, prompt, turn: kind ?? 'unknown', background },
  })
}

/**
 * Resumes each agent a restart cut off once: a few sessions start close together, then the next
 * few after a longer gap, so a restart with many cut turns does not load the host all at once.
 */
export async function resumeInterrupted(resumes: readonly Resume[], pace: ResumePace = PACE): Promise<void> {
  const once = [...new Map(resumes.map((each) => [each.taskId, each])).values()]
  for (const [index, each] of once.entries()) {
    if (index > 0) {
      await (pace.wait ?? pause)(index % pace.group === 0 ? pace.groupGapMs : pace.staggerMs)
    }
    try {
      await resumeOne(each, Date.now())
    } catch (e) {
      process.stderr.write(`resume: task ${each.taskId}: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
}

/** Turn-end listener: an agent that finished a turn made progress, so its resumes start over. */
export async function noteTurnFinished(taskId: string, status: string): Promise<void> {
  if (status === 'idle') {
    await restartCuts.progressed(taskId)
  }
}
