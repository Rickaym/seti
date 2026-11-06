import type { AgentInput, AgentInputKind, Task, TaskStatus } from '@seti/shared'
import { currentRequestSource } from './access.js'
import { refuseArchived } from './archive-guard.js'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { messages, now, tasks } from './db.js'
import { noticeAwaitedTurn } from './ea-turn-watch.js'
import { HttpError } from './http.js'
import { deliverInputs } from './inputs.js'
import { agentWaits, type AgentWait } from './store/agent-waits.js'
import { onAnyTaskEvent } from './task-events.js'
import { outsideLane } from './task-lane.js'

/** Waits one agent or the EA may have pending at once. */
const WAITS_MAX = 20
/** The most of an agent's final message an update carries. */
const FINAL_CHARS = 4000
const FINAL_SCAN = 40

/** Who hears back: an agent by task id, or the EA's inbox for null. */
type WaiterId = string | null

/**
 * The agent or the EA making the current request, once it can take one more wait; the user never
 * waits through Seti.
 */
export async function requestWaiter(): Promise<WaiterId> {
  const source = currentRequestSource()
  if (source?.via !== 'agent' && source?.via !== 'ea') {
    throw new HttpError(400, 'Only an agent or the EA can ask to hear when an agent ends its turn')
  }
  const waiter = source.via === 'agent' ? source.taskId : null
  const task = waiter === null ? undefined : await tasks.get(waiter)
  if (task !== undefined) {
    refuseArchived(task)
    if (task.input_mode === 'off') {
      throw new HttpError(409, 'Your updates are off, so Seti could not tell you; ask the user to turn them on')
    }
  }
  if ((await agentWaits.count(waiter)) >= WAITS_MAX) {
    throw new HttpError(409, `At most ${String(WAITS_MAX)} waits can be pending at once`)
  }
  return waiter
}

/**
 * Has Seti tell the waiter, the requesting agent or EA by default, once, when the target's
 * current turn ends, or its next one while it is idle.
 */
export async function awaitTurnEnd(target: Task, ready?: WaiterId): Promise<AgentWait> {
  refuseArchived(target)
  const waiter = ready === undefined ? await requestWaiter() : ready
  if (waiter === target.id) {
    throw new HttpError(409, 'An agent cannot wait for its own turn to end')
  }
  const wait = await agentWaits.add(waiter, target.id, now())
  await audit.record({
    actor: 'user',
    kind: 'task.wait_added',
    subject_type: 'task',
    subject_id: target.id,
    summary: `Asked to hear when task "${target.title}" ends its turn`,
    detail: { title: target.title, waiter: waiter ?? 'ea' },
  })
  return wait
}

/** Drops a wait set up for a message that could not be sent. */
export const dropWait = async (wait: AgentWait) => agentWaits.remove(wait.id)

const textOf = (row: Awaited<ReturnType<typeof messages.page>>['messages'][number]) =>
  row.kind === 'sdk' && row.payload.type === 'assistant' && row.payload.parent_tool_use_id === null
    ? row.payload.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    : ''

/** The agent's last words of its own, cut to a size an update can carry. */
async function finalMessage(taskId: string): Promise<string> {
  const page = await messages.page(taskId, FINAL_SCAN)
  const text = page.messages.map(textOf).findLast((words) => words.trim() !== '') ?? ''
  return text.length <= FINAL_CHARS ? text : `${text.slice(0, FINAL_CHARS)}\n[... cut]`
}

const ENDINGS: Record<AgentInputKind, string> = {
  idle: 'finished its turn',
  error: 'stopped with an error',
  stopped: 'was stopped',
}

const kindOf = (status: TaskStatus): AgentInputKind => (status === 'idle' || status === 'error' ? status : 'stopped')

async function agentInput(task: Task, status: TaskStatus): Promise<AgentInput> {
  const kind = kindOf(status)
  const words = await finalMessage(task.id)
  const error = kind === 'error' && task.last_error !== null ? `Error: ${task.last_error}` : ''
  return {
    source: 'agent',
    kind,
    task_id: task.id,
    subject: task.title,
    title: `${task.title} ${ENDINGS[kind]}`,
    body: [error, words].filter((part) => part !== '').join('\n\n'),
    url: null,
  }
}

async function deliver(task: Task, status: TaskStatus, waits: readonly AgentWait[]): Promise<void> {
  const input = await agentInput(task, status)
  for (const wait of waits) {
    if (wait.waiter_id === null) {
      await noticeAwaitedTurn(task, status)
    } else {
      await deliverInputs(wait.waiter_id, [input])
    }
  }
}

/** A turn's end goes once to everyone who waited for it, each in its own lane. */
export async function deliverAgentWaits(taskId: string, status: TaskStatus): Promise<void> {
  const waits = await agentWaits.take(taskId)
  const task = waits.length === 0 ? undefined : await tasks.get(taskId)
  if (task !== undefined) {
    inBackground(`agent waits: task ${taskId}`, async () => outsideLane(async () => deliver(task, status, waits)))
  }
}

/** Archiving an agent cancels the waits by it and on it. */
export function cancelWaitsOnArchive(): void {
  onAnyTaskEvent((taskId, event) => {
    if (event.type === 'archived' && event.archived) {
      inBackground(`agent waits: task ${taskId}`, async () => agentWaits.cancelFor(taskId))
    }
  })
}
