import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueueState, TaskStatus } from '@seti/shared'
import { z } from 'zod'
import type { LiveSession } from '../agent-session.js'
import { inBackground } from '../background.js'
import { OPENER_WAIT_MS, SESSION_IDLE_MS } from '../config.js'
import type { NextMessage } from '../next-message.js'
import type { SessionDecisions } from '../session-decisions.js'
import { inLane, outsideLane } from '../task-lane.js'
import type { ControlPort } from './port.js'

/** The session host's state: each task's open session, and the ports it reaches Seti through. */
export interface Host {
  live: Map<string, LiveSession>
  port: ControlPort
  decisions: SessionDecisions
}

/** One task's session, as the functions that drive it take it. */
export interface Ref {
  host: Host
  taskId: string
  session: LiveSession
}

/** Records the prompt on the records side and sends it into the session, which starts a turn. */
export async function send({ host, taskId, session }: Ref, next: NextMessage): Promise<void> {
  const { content, promptId } = await host.port.openTurn(taskId, next, false)
  session.send(content, promptId, next.prompt === null ? 'updates' : 'user')
}

async function enqueue({ host, taskId, session }: Ref, next: NextMessage): Promise<void> {
  const { content, promptId } = await host.port.openTurn(taskId, next, true)
  session.enqueue(content, promptId, next.prompt === null ? (next.priority ?? 'later') : undefined)
}

/** Sends the first message that waited, which starts a turn, and queues the rest behind it. */
export async function sendBacklog(ref: Ref): Promise<void> {
  const [first, ...rest] = ref.session.takeBacklog()
  if (first === undefined) {
    return
  }
  await send(ref, first)
  for (const next of rest) {
    await enqueue(ref, next)
  }
}

/** Settles each message a turn being cut short takes back; its prompt row follows in the lane. */
export const takenBack =
  ({ host, taskId, session }: Ref) =>
  (uuid: string) => {
    const promptId = session.settle(uuid)
    if (promptId !== null) {
      inBackground(`session: task ${taskId}`, async () =>
        outsideLane(async () => inLane(taskId, async () => host.port.queued(taskId, promptId, 'removed'))),
      )
    }
  }

/** Cuts the running turn short for a message, which goes out once the turn ended. */
export function interruptWith(ref: Ref, next: NextMessage): void {
  ref.session.replaceBacklog(next)
  if (ref.session.started) {
    void ref.session.cutShort('replace', takenBack(ref))
  }
}

/** Queues a message for the running turn, or holds it while the turn starts or is cut short. */
export async function queueFor(ref: Ref, next: NextMessage): Promise<void> {
  if (ref.session.accepting) {
    await enqueue(ref, next)
  } else {
    ref.session.hold(next)
  }
}

/** Records where a message the session queued went, if it was still waiting. */
async function settleQueued({ host, taskId, session }: Ref, uuid: string, state: Exclude<QueueState, 'waiting'>) {
  const promptId = session.settle(uuid)
  if (promptId !== null) {
    await host.port.queued(taskId, promptId, state)
  }
}

const commandLifecycle = z.object({
  type: z.literal('command_lifecycle'),
  command_uuid: z.string(),
  state: z.string(),
})

/**
 * Follows Claude Code's reports on the messages it queued, which the SDK types leave out; true
 * for such a report, which is bookkeeping rather than transcript.
 */
async function followQueue(ref: Ref, m: SDKMessage): Promise<boolean> {
  const report = commandLifecycle.safeParse(m)
  if (!report.success) {
    return false
  }
  const { command_uuid: uuid, state } = report.data
  if (state === 'queued') {
    ref.session.arrived(uuid)
  } else if (state === 'started') {
    await settleQueued(ref, uuid, 'delivered')
  } else if (state === 'cancelled') {
    await settleQueued(ref, uuid, 'removed')
  }
  return true
}

export const endStatus = (error: string | null): TaskStatus => (error === null ? 'idle' : 'error')

async function closeTurn(ref: Ref, error: string | null): Promise<void> {
  const { host, taskId, session } = ref
  const ending = session.endTurn()
  if (session.restartCut) {
    session.close()
  } else if (ending !== null && session.backlog.length > 0) {
    await sendBacklog(ref)
  } else if (session.queuedUuids.length > 0) {
    session.carryOn()
  } else {
    await host.port.turnEnded(taskId, ending === 'stop' ? 'stopped' : endStatus(error), error)
    session.closeWhenIdle(SESSION_IDLE_MS)
  }
  session.turnReported()
}

/**
 * A result ends the turn. Messages that waited for it to be cut short go out next; queued ones
 * Claude Code has not handed over yet start a turn of its own; otherwise the task stops working.
 * A notification turn ahead of the turn's message ends it only if the session then goes quiet.
 */
async function endTurn(ref: Ref, m: SDKResultMessage, error: string | null): Promise<void> {
  for (const uuid of m.user_message_uuids ?? []) {
    await settleQueued(ref, uuid, 'delivered')
  }
  if (!ref.session.precedesOpener(m)) {
    await closeTurn(ref, error)
    return
  }
  ref.session.awaitOpener(OPENER_WAIT_MS, (still) => {
    const quiet = async () => (still() ? closeTurn(ref, error) : undefined)
    inBackground(`session: task ${ref.taskId}`, async () => inLane(ref.taskId, quiet))
  })
}

/** The task's own agent working again; messages of background subagents do not count. */
const startsWork = (m: SDKMessage) =>
  (m.type === 'assistant' && m.parent_tool_use_id === null) || (m.type === 'system' && m.subtype === 'init')

/** Follows the session: results end turns, and background work reporting back starts new ones. */
async function follow(ref: Ref, m: SDKMessage, error: string | null): Promise<void> {
  const { host, taskId, session } = ref
  if (m.type === 'result') {
    await endTurn(ref, m, error)
  } else if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
    if (session.setBackground(m.tasks)) {
      host.port.sessionChanged(taskId)
    }
    session.closeWhenIdle(SESSION_IDLE_MS)
  } else if (startsWork(m) && session.resumeWork()) {
    await host.port.working(taskId)
  }
}

/** The error a result reports, or null for any other message and a result without one. */
function resultError(m: SDKMessage): string | null {
  if (m.type !== 'result' || !m.is_error) {
    return null
  }
  return m.subtype === 'success' ? m.result : m.subtype
}

/** Thinking token estimates, which nothing shows, so they are neither stored nor followed. */
const isEstimate = (m: SDKMessage) => m.type === 'system' && m.subtype === 'thinking_tokens'

const isCompaction = (m: SDKMessage) => m.type === 'system' && m.subtype === 'compact_boundary'

/** Hands a message of the session to the records side and follows it; returns its error. */
export async function take(ref: Ref, m: SDKMessage): Promise<string | null> {
  const { host, taskId, session } = ref
  session.note(m)
  if (isEstimate(m) || (await followQueue(ref, m))) {
    return null
  }
  const contextWindow = isCompaction(m) ? await session.contextWindow() : undefined
  await host.port.message(taskId, contextWindow === undefined ? { message: m } : { message: m, contextWindow })
  const error = resultError(m)
  await follow(ref, m, error)
  return error
}
