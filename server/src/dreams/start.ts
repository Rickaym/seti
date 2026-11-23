import fs from 'node:fs'
import path from 'node:path'
import type { DreamRun, DreamSettings, Task } from '@seti/shared'
import { audit } from '../audit.js'
import { inBackground } from '../background.js'
import { tasks } from '../db.js'
import { fromDelegate } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { pendingRequests } from '../pending-requests.js'
import type { DreamSupport } from '../runtimes/adapter.js'
import { adapterFor, DEFAULT_RUNTIME } from '../runtimes/registry.js'
import { isRunning, sessionState } from '../session-mirror.js'
import { dreamSettings, nightRuns } from '../store/dream-nights.js'
import { dreamRuns } from '../store/dreams.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { todayZone } from '../team-active.js'
import { forgetBefore, keptBefore, recordAfter } from './kept.js'
import { snapshotMemory, type MemorySnapshot } from './memory-snapshot.js'
import { DREAM_LIMITS, runDream, type DreamLimits } from './run.js'

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

/** Why an agent cannot dream now; `wait` when it may later tonight, such as when it is at work. */
export interface DreamRefusal {
  text: string
  wait: boolean
}

/** Why the agent cannot dream now, or null when it can. */
export async function dreamRefusal(task: Task): Promise<DreamRefusal | null> {
  const dream = adapterFor(DEFAULT_RUNTIME).capabilities.dream
  const checks: [boolean | (() => Promise<boolean>), string, boolean][] = [
    [task.archived_at !== null, 'The agent is archived.', false],
    [dream === null, "The agent's runtime keeps no memory Seti can find.", false],
    [
      async () => !(await sandboxPolicy.get()).enabled || !task.sandbox,
      'The agent runs without the sandbox, so a dream could not be contained.',
      false,
    ],
    [dreaming.has(task.id), 'The agent is dreaming already.', true],
    [
      isRunning(task.id) || sessionState(task.id).background > 0,
      'The agent is at work; dream when its turn and background work end.',
      true,
    ],
    [async () => waitsOnUser(task.id), 'The agent waits on you: answer its open request first.', true],
    [
      dream !== null && lockIsFresh(dream.memory(task.cwd)),
      "Claude Code tidied this agent's memory within the hour; dream later.",
      true,
    ],
  ]
  for (const [check, text, wait] of checks) {
    if (typeof check === 'boolean' ? check : await check()) {
      return { text, wait }
    }
  }
  return null
}

/** What one dream of the agent may use under Dreaming's settings. */
export function dreamLimits(task: Pick<Task, 'model'>, settings: DreamSettings): DreamLimits {
  const model = settings.model === 'agent' ? (task.model ?? DREAM_LIMITS.model) : settings.model
  return { ...DREAM_LIMITS, model, budgetUsd: settings.dream_budget_usd }
}

/** The local date in Dreaming's zone, else Seti's, which names the night a dream belongs to. */
async function nightOf(at: Date, settings: DreamSettings): Promise<string> {
  const zone = settings.zone ?? (await todayZone())
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(at)
}

interface Ready {
  dream: DreamSupport
  memory: string
  before: MemorySnapshot
}

/** The memory folder and its state before a dream, or why it cannot dream; claims the agent. */
async function prepare(task: Task): Promise<Ready | string> {
  const dream = adapterFor(DEFAULT_RUNTIME).capabilities.dream
  if (dream === null) {
    return "The agent's runtime keeps no memory Seti can find."
  }
  const memory = dream.memory(task.cwd)
  const before = await snapshotMemory(memory)
  if (!before.ok) {
    return `${before.reason} Tidy it by hand before a dream.`
  }
  if (dreaming.has(task.id)) {
    return 'The agent is dreaming already.'
  }
  dreaming.add(task.id)
  return { dream, memory, before: before.files }
}

/** Audits the start and runs the dream in the background, releasing the agent at its end. */
async function launch(task: Task, run: DreamRun, ready: Ready, limits: DreamLimits): Promise<void> {
  await audit.record({
    actor: run.kind === 'manual' ? 'user' : 'system',
    kind: 'dream.started',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Started a dream of ${task.title}`,
    detail: { run: run.id, night: run.night, attempt: run.attempt, model: run.model, budget_usd: limits.budgetUsd },
  })
  inBackground(`dream of task ${task.id}`, async () =>
    runDream({ task, run, ...ready, limits }).finally(() => dreaming.delete(task.id)),
  )
}

/** Why the night's budget leaves no room for one more dream, or null when it does. */
export async function nightBudgetRefusal(night: string, settings: DreamSettings): Promise<string | null> {
  const spent = await nightRuns.cost(night)
  if (spent + settings.dream_budget_usd <= settings.night_budget_usd) {
    return null
  }
  return `The night's dream budget is spent: ${spent.toFixed(2)} of ${settings.night_budget_usd.toFixed(2)} dollars.`
}

/** Why the EA, an agent or a mod cannot start this dream, or null: one a day is theirs. */
async function delegateRefusal(taskId: string, night: string): Promise<string | null> {
  if (!fromDelegate() || (await dreamRuns.forTask(taskId, 1))[0]?.night !== night) {
    return null
  }
  return 'The agent dreamt today already; only the user starts another, in Seti.'
}

/**
 * Starts one dream of the agent now, outside any window, under Dreaming's caps; the dream runs in
 * the background and the run is answered at once. Refused with 409 and the reason. The EA, an
 * agent or a mod starts at most one dream of an agent a day; only the user starts more.
 */
export async function startDream(task: Task): Promise<DreamRun> {
  const settings = await dreamSettings.get()
  const night = await nightOf(new Date(), settings)
  const refusal =
    (await dreamRefusal(task))?.text ??
    (await delegateRefusal(task.id, night)) ??
    (await nightBudgetRefusal(night, settings))
  const ready = refusal ?? (await prepare(task))
  if (typeof ready === 'string') {
    throw new HttpError(409, ready)
  }
  try {
    const limits = dreamLimits(task, settings)
    const run = await dreamRuns.start({ task_id: task.id, night, kind: 'manual', model: limits.model })
    await launch(task, run, ready, limits)
    return run
  } catch (e) {
    dreaming.delete(task.id)
    throw e
  }
}

/**
 * Starts a planned nightly dream the ticker chose, stopping at `until`, or says why it cannot:
 * a refusal with `wait` may pass later tonight, any other skips the dream.
 */
export async function startNightly(
  task: Task,
  planned: DreamRun,
  settings: DreamSettings,
  until: number,
): Promise<DreamRefusal | null> {
  const refusal = await dreamRefusal(task)
  const ready = refusal ?? (await prepare(task))
  if (typeof ready === 'string' || 'text' in ready) {
    return typeof ready === 'string' ? { text: ready, wait: false } : ready
  }
  const limits = { ...dreamLimits(task, settings), until }
  try {
    const run = await nightRuns.claim(planned.id, limits.model)
    if (run === undefined) {
      dreaming.delete(task.id)
      return null
    }
    await launch(task, run, ready, limits)
    return null
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
