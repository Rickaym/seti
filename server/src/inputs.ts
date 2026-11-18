import {
  type AgentState,
  type AuditActor,
  type ChannelRoute,
  type InputMode,
  type InputsDismissed,
  type Task,
  type TaskInput,
  type TaskStatus,
  WAKING_SOURCES,
  deliveryStep,
  heldForMessage,
  sourceCounts,
} from '@seti/shared'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { messages, tasks } from './db.js'
import { watchUpdatesWaiting } from './ea-watch.js'
import { HttpError } from './http.js'
import type { NextMessage } from './next-message.js'
import { appendMessage, autoQueueBlocker, isRunning, publish, runAutoTurn } from './runner.js'
import { shellTurnGuard } from './shell-context.js'
import { taskInputs } from './store/inputs.js'
import { onAnyTaskEvent } from './task-events.js'
import { inLane, outsideLane } from './task-lane.js'
import { startFailed } from './unstarted.js'
import { signalWorkspaces } from './workspace/dir.js'

/** Automatic turns within the window that pause waking, so a runaway loop cannot run on. */
export const AUTO_TURN_BURST = { turns: 20, windowMs: 60 * 60_000 } as const

/** Updates wake the agent once none came for quietMs, and at most maxMs after the first. */
export const WAKE_DEBOUNCE = { quietMs: 5_000, maxMs: 30_000 } as const

const resumeTimers = new Map<string, NodeJS.Timeout>()

interface DebouncedWake {
  timer: NodeJS.Timeout
  firstAt: number
}

const debouncedWakes = new Map<string, DebouncedWake>()

const NOTHING_WAITING = 'No update is waiting'

const HOLDS = 'The agent holds updates until the next message'
const HELD_FOR_MESSAGE = "Held for the user's next message"
const AWAITS_ANSWER = 'The agent waits on the user; updates join its turn once the user answered'

/** Whether Seti hands the pending updates over now, and how; else why not. */
type WakePlan = { blocker: string } | { blocker: null; joining: boolean }

const blockedBy = (blocker: string): WakePlan => ({ blocker })

/** The agent as an update finds it; a turn that waits on the user's answer is blocked. */
function agentState(task: Task): AgentState {
  if (!isRunning(task.id)) {
    return 'idle'
  }
  return task.blocked === null ? 'running' : 'blocked'
}

/** Why the task takes no update by itself whatever waits, or null. */
function taskBlocker(task: Task): string | null {
  if (task.input_mode !== 'wake') {
    return HOLDS
  }
  if (startFailed(task.id)) {
    return 'The agent could not start its session; updates wait until the user retries'
  }
  return shellTurnGuard(task.id)
}

/**
 * How Seti would hand the pending updates over now: in a turn of their own, or joining the
 * running one when any update asks for that. A burst pause also schedules the wake for its end.
 */
async function wakePlan(taskId: string): Promise<WakePlan> {
  const task = await tasks.get(taskId)
  if (!task) {
    return blockedBy('Task not found')
  }
  const blocker = taskBlocker(task)
  if (blocker !== null) {
    return blockedBy(blocker)
  }
  const urgency = await taskInputs.waking(taskId, WAKING_SOURCES)
  if (urgency === null) {
    return blockedBy(NOTHING_WAITING)
  }
  const step = deliveryStep(task.input_mode, urgency, agentState(task))
  if (step === 'after_answer') {
    return blockedBy(AWAITS_ANSWER)
  }
  const queueing = autoQueueBlocker(taskId, step === 'join')
  if (queueing !== null) {
    return blockedBy(queueing)
  }
  const paused = await burstPausedUntil(taskId)
  if (paused !== null) {
    wakeAt(taskId, paused)
    return blockedBy(`Paused after a burst of automatic turns until ${paused.toISOString()}`)
  }
  return { blocker: null, joining: step === 'join' }
}

/** When a burst of automatic turns since the user last wrote stops pausing waking, or null. */
export async function burstPausedUntil(taskId: string, now = Date.now()): Promise<Date | null> {
  const since = new Date(now - AUTO_TURN_BURST.windowMs).toISOString()
  const turns = await taskInputs.autoTurnsSince(taskId, since, AUTO_TURN_BURST.turns)
  const oldest = turns.at(AUTO_TURN_BURST.turns - 1)
  return oldest === undefined ? null : new Date(Date.parse(oldest) + AUTO_TURN_BURST.windowMs)
}

function wakeAt(taskId: string, at: Date): void {
  clearTimeout(resumeTimers.get(taskId))
  const timer = setTimeout(
    () => {
      resumeTimers.delete(taskId)
      inBackground(`wake: task ${taskId}`, async () => outsideLane(async () => wakeTask(taskId)))
    },
    Math.max(0, at.getTime() - Date.now()),
  )
  timer.unref()
  resumeTimers.set(taskId, timer)
}

/** How pending updates go out: joining a running turn with a priority, held ones included. */
type HandOver = Pick<NextMessage, 'priority' | 'held'>

/** Hands the agent the pending updates, queued for a running turn, and records who asked. */
export async function deliverPending(taskId: string, actor: AuditActor, how: HandOver = {}): Promise<number> {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new HttpError(404, 'Task not found')
  }
  clearTimeout(debouncedWakes.get(taskId)?.timer)
  debouncedWakes.delete(taskId)
  const count = await runAutoTurn(taskId, how)
  await audit.record({
    actor,
    kind: 'task.inputs_delivered',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Delivered ${String(count)} ${count === 1 ? 'update' : 'updates'} to task "${task.title}"`,
    detail: { title: task.title, count },
  })
  return count
}

/** Discards waiting updates up to `upTo`, the newest the caller saw; the transcript keeps them. */
export async function dismissPending(taskId: string, upTo: number, actor: AuditActor): Promise<InputsDismissed> {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new HttpError(404, 'Task not found')
  }
  const rows = await inLane(taskId, async () => {
    const ids = await taskInputs.dismiss(taskId, upTo, new Date().toISOString())
    const found = await Promise.all(ids.map(async (id) => messages.get(taskId, id)))
    return found.flatMap((row) => (row?.kind === 'input' ? [row] : []))
  })
  if (rows.length === 0) {
    throw new HttpError(409, 'No update is waiting for the agent')
  }
  for (const row of rows) {
    publish(taskId, { type: 'updated', row })
  }
  const all = rows.map((row) => row.payload.source)
  const sources = [...new Set(all)]
  const count = rows.length
  await audit.record({
    actor,
    kind: 'task.inputs_dismissed',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Dismissed ${String(count)} ${count === 1 ? 'update' : 'updates'} (${sourceCounts(all)}) for task "${task.title}"`,
    detail: { title: task.title, count, sources },
  })
  return { count, sources }
}

/** Hands pending updates to the agent when the task wants that; null when it did, else why not. */
async function tryWake(taskId: string): Promise<string | null> {
  return inLane(taskId, async () => {
    try {
      const plan = await wakePlan(taskId)
      if (plan.blocker !== null) {
        return plan.blocker
      }
      await deliverPending(taskId, 'system', plan.joining ? { priority: 'next' } : {})
      return null
    } catch (e) {
      // Callers include turn cleanup and startup, where a throw would take the server down.
      const text = e instanceof Error ? e.message : String(e)
      process.stderr.write(`could not hand updates to task ${taskId}: ${text}\n`)
      return `Could not start a turn: ${text}`
    }
  })
}

/** Hands pending updates to the agent when the task wants that; returns whether it did. */
export async function wakeTask(taskId: string): Promise<boolean> {
  return (await tryWake(taskId)) === null
}

/** A turn the user stopped stays stopped; any other end picks up updates that came meanwhile. */
export async function wakeAfterTurn(taskId: string, status: TaskStatus): Promise<void> {
  if (status !== 'stopped') {
    await wakeTask(taskId)
  }
}

/**
 * Hands the running turn the updates held for the user's next message, since an answer to the
 * agent's question is one; they join the turn at its next step.
 */
export async function releaseHeld(taskId: string): Promise<void> {
  if (!isRunning(taskId) || !(await taskInputs.held(taskId))) {
    return
  }
  try {
    await deliverPending(taskId, 'user', { priority: 'next', held: true })
  } catch (e) {
    process.stderr.write(
      `could not hand held updates to task ${taskId}: ${e instanceof Error ? e.message : String(e)}\n`,
    )
  }
}

/** Updates that waited for the user's answer join the turn once nothing blocks the agent. */
export function wakeWhenUnblocked(): void {
  onAnyTaskEvent((taskId, event) => {
    if (event.type === 'blocked' && event.blocked === null && isRunning(taskId)) {
      inBackground(`wake: task ${taskId}`, async () => outsideLane(async () => wakeTask(taskId)))
    }
  })
}

/** Hands over updates that waited through a restart, for every task that wakes on them. */
export async function wakeWaiting(): Promise<void> {
  for (const task of await tasks.list()) {
    if (task.input_mode === 'wake') {
      await wakeTask(task.id)
    }
  }
}

/** Wakes the agent for its updates once they stop coming closely, as WAKE_DEBOUNCE sets. */
function wakeSoon(taskId: string): void {
  const now = Date.now()
  const earlier = debouncedWakes.get(taskId)
  clearTimeout(earlier?.timer)
  const firstAt = earlier?.firstAt ?? now
  const timer = setTimeout(
    () => {
      debouncedWakes.delete(taskId)
      inBackground(`wake: task ${taskId}`, async () =>
        outsideLane(async () => {
          const blocker = await tryWake(taskId)
          if (blocker !== null && blocker !== NOTHING_WAITING) {
            await watchUpdatesWaiting(taskId)
          }
        }),
      )
    },
    Math.max(0, Math.min(WAKE_DEBOUNCE.quietMs, firstAt + WAKE_DEBOUNCE.maxMs - now)),
  )
  timer.unref()
  debouncedWakes.set(taskId, { timer, firstAt })
}

export type InputOutcome = Pick<ChannelRoute, 'outcome' | 'reason'>

/** Records updates and, if the task wants that, wakes the agent once more updates stop coming. */
export async function deliverInputs(taskId: string, inputs: readonly TaskInput[]): Promise<InputOutcome> {
  return inLane(taskId, async (): Promise<InputOutcome> => {
    const task = await tasks.get(taskId)
    if (task === undefined) {
      return { outcome: 'skipped', reason: 'The task is gone' }
    }
    if (task.archived_at !== null) {
      return { outcome: 'skipped', reason: 'The task is archived' }
    }
    if (task.input_mode === 'off' || inputs.length === 0) {
      return { outcome: 'ignored', reason: 'The task ignores updates' }
    }
    for (const input of inputs) {
      await appendMessage(taskId, { kind: 'input', payload: input })
    }
    if (inputs.every(heldForMessage)) {
      await watchUpdatesWaiting(taskId)
      return { outcome: 'queued', reason: task.input_mode === 'wake' ? HELD_FOR_MESSAGE : HOLDS }
    }
    const plan = await wakePlan(taskId)
    if (plan.blocker === null) {
      wakeSoon(taskId)
      const reason = plan.joining
        ? 'Joining the running turn in a few seconds'
        : 'Handing to the agent in a few seconds'
      return { outcome: 'delivered', reason }
    }
    await watchUpdatesWaiting(taskId)
    return { outcome: task.input_mode === 'queue' ? 'queued' : 'held', reason: plan.blocker }
  })
}

const MODE_LABELS: Record<InputMode, string> = {
  wake: 'start a turn for',
  queue: 'hold',
  off: 'ignore',
}

/** Changes what the task does with updates; switching to wake picks up any that are waiting. */
export async function setInputMode(task: Task, mode: InputMode): Promise<void> {
  if (task.input_mode === mode) {
    return
  }
  await tasks.setInputMode(task.id, mode)
  signalWorkspaces('packs', task.id)
  await audit.record({
    actor: 'user',
    kind: 'task.input_mode_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Set task "${task.title}" to ${MODE_LABELS[mode]} updates`,
    detail: { title: task.title, from: task.input_mode, to: mode },
  })
  if (mode === 'wake') {
    await wakeTask(task.id)
  }
}
