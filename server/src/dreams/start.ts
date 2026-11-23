import fs from 'node:fs'
import path from 'node:path'
import type { DreamRun, Task } from '@seti/shared'
import { audit } from '../audit.js'
import { inBackground } from '../background.js'
import { tasks } from '../db.js'
import { fromDelegate } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { pendingRequests } from '../pending-requests.js'
import { adapterFor, DEFAULT_RUNTIME } from '../runtimes/registry.js'
import { isRunning, sessionState } from '../session-mirror.js'
import { dreamRuns } from '../store/dreams.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { todayZone } from '../team-active.js'
import { forgetBefore, keptBefore, recordAfter } from './kept.js'
import { snapshotMemory } from './memory-snapshot.js'
import { DREAM_LIMITS, runDream } from './run.js'

/** Claude Code's own consolidation holds this file while it runs; its mtime is its last run. */
const CLAUDE_LOCK = '.consolidate-lock'
const LOCK_FRESH_MS = 60 * 60_000

/** Agents whose dream is starting or running in this process, so two never start at once. */
const dreaming = new Set<string>()

/** Whether the agent waits on the user: an open question, permission or change request. */
async function waitsOnUser(taskId: string): Promise<boolean> {
  const open = await pendingRequests(taskId)
  return (
    open.questions.some((question) => question.task_id === taskId) ||
    open.permissions.length > 0 ||
    open.access.length > 0
  )
}

function lockIsFresh(memory: string): boolean {
  const stat = fs.statSync(path.join(memory, CLAUDE_LOCK), { throwIfNoEntry: false })
  return stat !== undefined && Date.now() - stat.mtimeMs < LOCK_FRESH_MS
}

/** Why the agent cannot dream now, or null when it can. */
async function dreamRefusal(task: Task): Promise<string | null> {
  const dream = adapterFor(DEFAULT_RUNTIME).capabilities.dream
  const checks: [boolean | (() => Promise<boolean>), string][] = [
    [task.archived_at !== null, 'The agent is archived.'],
    [dream === null, "The agent's runtime keeps no memory Seti can find."],
    [
      async () => !(await sandboxPolicy.get()).enabled || !task.sandbox,
      'The agent runs without the sandbox, so a dream could not be contained.',
    ],
    [
      isRunning(task.id) || sessionState(task.id).background > 0,
      'The agent is at work; dream when its turn and background work end.',
    ],
    [async () => waitsOnUser(task.id), 'The agent waits on you: answer its open request first.'],
    [
      dream !== null && lockIsFresh(dream.memory(task.cwd)),
      "Claude Code tidied this agent's memory within the hour; dream later.",
    ],
  ]
  for (const [check, reason] of checks) {
    if (typeof check === 'boolean' ? check : await check()) {
      return reason
    }
  }
  return null
}

/** The local date in Seti's zone, which names the night a dream belongs to. */
async function nightOf(at: Date): Promise<string> {
  return new Intl.DateTimeFormat('en-CA', { timeZone: await todayZone() }).format(at)
}

/**
 * Starts one dream of the agent now, outside any window, under the dream limits; the dream runs
 * in the background and the run is answered at once. Refused with 409 and the reason. The EA, an
 * agent or a mod starts at most one dream of an agent a day; only the user starts more.
 */
export async function startDream(task: Task): Promise<DreamRun> {
  const refusal = await dreamRefusal(task)
  const dream = adapterFor(DEFAULT_RUNTIME).capabilities.dream
  if (refusal !== null || dream === null) {
    throw new HttpError(409, refusal ?? "The agent's runtime keeps no memory Seti can find.")
  }
  const night = await nightOf(new Date())
  if (fromDelegate() && (await dreamRuns.forTask(task.id, 1))[0]?.night === night) {
    throw new HttpError(409, 'The agent dreamt today already; only the user starts another, in Seti.')
  }
  const memory = dream.memory(task.cwd)
  const before = await snapshotMemory(memory)
  if (!before.ok) {
    throw new HttpError(409, `${before.reason} Tidy it by hand before a dream.`)
  }
  if (dreaming.has(task.id)) {
    throw new HttpError(409, 'The agent is dreaming already.')
  }
  dreaming.add(task.id)
  try {
    const run = await dreamRuns.start({
      task_id: task.id,
      night,
      kind: 'manual',
      model: DREAM_LIMITS.model,
    })
    await audit.record({
      actor: 'user',
      kind: 'dream.started',
      subject_type: 'task',
      subject_id: task.id,
      summary: `Started a dream of ${task.title}`,
      detail: { run: run.id, night: run.night, model: run.model, budget_usd: DREAM_LIMITS.budgetUsd },
    })
    inBackground(`dream of task ${task.id}`, async () =>
      runDream({ task, run, memory, before: before.files, dream }).finally(() => dreaming.delete(task.id)),
    )
    return run
  } catch (e) {
    dreaming.delete(task.id)
    throw e
  }
}

/** Marks the dreams a restart cut, since their session ended with the process. */
export async function cutDreamsAtStart(): Promise<void> {
  for (const run of await dreamRuns.cutRunning('Seti restarted during the dream.')) {
    const before = keptBefore(run.task_id, run.id)
    const task = await tasks.get(run.task_id)
    const memory = adapterFor(DEFAULT_RUNTIME).capabilities.dream?.memory(task?.cwd ?? '') ?? null
    if (before !== null && task !== undefined && memory !== null) {
      await recordAfter(run.task_id, run, memory, before)
    }
    forgetBefore(run.task_id, run.id)
    await audit.record({
      actor: 'system',
      kind: 'dream.ended',
      subject_type: 'task',
      subject_id: run.task_id,
      summary: 'A restart cut a dream',
      detail: { run: run.id, state: run.state },
    })
  }
}
