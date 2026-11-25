import { bypassOn, RUNTIME_NAMES, type StoredRuntime, type Task } from '@seti/shared'
import { ceilingOf } from '../approval-ceiling.js'
import { requireRuntime } from '../codex-status.js'
import { tasks } from '../db.js'
import { fromDelegate } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { appendMessage, type TurnPreface } from '../runner.js'
import { runsUnsandboxed } from '../runtimes/capabilities.js'
import { approvalCeilings } from '../store/approval-ceilings.js'
import { bypass } from '../store/permissions.js'
import { continuedNotes } from '../store/processes.js'
import { taskSessions } from '../store/task-sessions.js'
import { handoverBrief } from './handover.js'

/** The runtime an agent moves to, with a model, or null for that runtime's default. */
export interface Move {
  runtime: StoredRuntime
  model: string | null
}

/** What the move did besides the runtime, for its audit record. */
export interface Moved {
  from: StoredRuntime
  resumed: boolean
  bypassEnded: boolean
  heldToCeiling: boolean
}

const ENDED =
  'Background shells, processes and subagents started before the move have ended; start again any you still need.'

/**
 * Refuses a move to the agent's own runtime, to one that runs only sandboxed while the agent runs
 * unsandboxed, or to one that cannot start an agent on its credential now.
 */
export async function refuseMove(task: Task, to: StoredRuntime): Promise<void> {
  const name = RUNTIME_NAMES[to]
  if (to === task.runtime) {
    throw new HttpError(409, `${task.title} already runs on ${name}.`)
  }
  if (!task.sandbox && !runsUnsandboxed(to)) {
    throw new HttpError(409, `${name} runs only in Seti's sandbox; turn the sandbox on for ${task.title} first.`)
  }
  await requireRuntime(to, task.profile_id)
}

/**
 * Moves an ended session's agent to another runtime, inside its lane: its next session resumes
 * the one it last had there, else starts anew, and its next turn gets a brief of its work. Bypass
 * ends; a move the EA or an agent made never loosens the approvals the agent had.
 */
export async function moveRuntime(task: Task, to: Move): Promise<Moved> {
  const was = await tasks.get(task.id)
  if (was === undefined || was.runtime === to.runtime) {
    throw new HttpError(409, `${task.title} already runs on ${RUNTIME_NAMES[to.runtime]}.`)
  }
  return moveFrom(was, to)
}

async function moveFrom(task: Task, to: Move): Promise<Moved> {
  const ceiling = fromDelegate() ? await ceilingOf(task) : null
  const resumed = (await taskSessions.moveTo(task.id, to.runtime, to.model)) !== null
  if (ceiling !== null) {
    await approvalCeilings.set(task.id, ceiling)
  }
  const bypassEnded = bypassOn(task.bypass_until)
  if (bypassEnded) {
    await bypass.set(task.id, null)
  }
  const again = resumed ? ', resuming its earlier session there' : ''
  const error = `Continued on ${RUNTIME_NAMES[to.runtime]}${again}. The conversation stays here; the agent gets a brief of its work with its next message.`
  await appendMessage(task.id, { kind: 'seti', payload: { error, session: 'continued', runtime_was: task.runtime } })
  return { from: task.runtime, resumed, bypassEnded, heldToCeiling: ceiling !== null }
}

/** The latest move since the agent last read a message, with a brief of its work before it. */
export async function continuedPreface(taskId: string): Promise<TurnPreface | null> {
  const was = await continuedNotes.sinceLastTurn(taskId)
  const task = was === null ? undefined : await tasks.get(taskId)
  if (was === null || task === undefined) {
    return null
  }
  const moved = `Seti moved you from ${RUNTIME_NAMES[was]} to ${RUNTIME_NAMES[task.runtime]}; your folders, links and conversation in Seti stay the same.`
  return { text: `${moved} ${ENDED}\n\n${await handoverBrief(task)}`, count: 1 }
}
