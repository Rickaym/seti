import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageBody, MessageRow, PromptAttachment, Task, TaskSession, TaskStatus } from '@seti/shared'
import { outsideRequest } from './access.js'
import { LiveSession, outcomeOf, type NextMessage, type SendOutcome } from './agent-session.js'
import { refuseArchived } from './archive-guard.js'
import { audit } from './audit.js'
import { inBackground, onShutdown } from './background.js'
import { closingLine } from './closing-line.js'
import { withContextWindow } from './compact.js'
import { CLAUDE_HOME, OPENER_WAIT_MS, SESSION_IDLE_MS } from './config.js'
import { linkCreatedPrs } from './created-prs.js'
import { messages, tasks } from './db.js'
import { HttpError } from './http.js'
import { watchSessionMcp } from './mcp-session-status.js'
import { outwardToolUses } from './outward.js'
import { followQueue, markQueued, settleQueued } from './queued-prompts.js'
import { resumeSession } from './rewind.js'
import { startQuery } from './sdk-query.js'
import { checkSend } from './send-check.js'
import { moveSessionTo } from './session-files.js'
import { sessionOpening } from './session-hooks.js'
import { sessionStart, setupKey } from './session-options.js'
import { recordSessionStart, storedForm } from './session-start.js'
import { withTurnCost } from './store/cost.js'
import { rewinds } from './store/rewinds.js'
import { hadRunningSubtask } from './subtask-cache.js'
import { publishFolded, publishSubtasks } from './subtask-prs.js'
import { publish } from './task-events.js'
import { inLane, outsideLane } from './task-lane.js'
import { forgetToolCalls, trackToolCalls } from './tool-calls.js'
import { turnAsks } from './turn-asking.js'
import { promptFor } from './turn-prompt.js'
import { keepUnstarted, sessionError, takeUnstarted } from './unstarted.js'
import { userContent, type UserContent } from './user-content.js'

export { agentEnv, registerContextProvider, registerSessionMcpServers } from './session-options.js'
export { publish, subscribe } from './task-events.js'
export { registerTurnPreface, type TurnPreface } from './turn-prompt.js'

/** Each task's open Claude Code session, from its first message until it is closed. */
const live = new Map<string, LiveSession>()

/**
 * Called once the task stops working, with the status it ended in. A turn that a new message cut
 * short, or that Claude Code follows with a turn of its own for queued messages, does not count.
 */
type TurnEndListener = (taskId: string, status: TaskStatus) => void | Promise<void>

const turnEndListeners: TurnEndListener[] = []

/** @public */
export function onTurnEnd(listener: TurnEndListener): void {
  turnEndListeners.push(listener)
}

/** First message of the task's open session, which may still run subagents it started. */
export const openQuerySince = (taskId: string): number | null => live.get(taskId)?.since ?? null

/** Whether the task has a Claude Code process open, and how much background work runs in it. */
export function sessionState(taskId: string): TaskSession {
  const session = live.get(taskId)
  return { open: session !== undefined && !session.closed, background: session?.backgroundCount ?? 0 }
}

function publishSession(taskId: string): void {
  publish(taskId, { type: 'session', session: sessionState(taskId) })
}

export async function appendMessage(taskId: string, body: MessageBody, outward: string[] = []): Promise<MessageRow> {
  const row = await messages.insert(taskId, body, outward)
  publish(taskId, { type: 'message', row })
  await publishFolded(taskId, openQuerySince(taskId))
  return row
}

async function setStatus(taskId: string, status: TaskStatus): Promise<void> {
  await tasks.setStatus(taskId, status, null)
  publish(taskId, { type: 'status', status })
}

/** Whether a turn is in progress; a session open only for background work does not count. */
export const isRunning = (taskId: string) => live.get(taskId)?.running === true

interface TurnOptions {
  /** Cut a running turn short instead of queueing the message for it. */
  interrupt?: boolean
  attachments?: PromptAttachment[]
  /** Sends the user's last message again, which only an idle agent takes. */
  retry?: boolean
  /** The browser's id for the send, kept on the prompt row so the browser can match it. */
  clientId?: string
  /** Who wrote the message when not the user. */
  from?: string | undefined
}

/** Sends the user's prompt and its files to the task's agent, after what the turn prefaces report. */
export async function runTurn(taskId: string, prompt: string, options: TurnOptions = {}): Promise<SendOutcome> {
  const message = {
    prompt,
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.retry === true ? { retry: true } : {}),
    ...(options.clientId === undefined ? {} : { client_id: options.clientId }),
    ...(options.from === undefined ? {} : { from: options.from }),
  }
  return (await inLane(taskId, async () => startTurn(taskId, message, options.interrupt === true))).outcome
}

/**
 * Hands the agent the pending prefaces with no user text, in a new turn or queued for a turn of
 * their own after the running one, or sooner with a priority; returns their count.
 */
export async function runAutoTurn(taskId: string, priority?: NextMessage['priority']): Promise<number> {
  const message = priority === undefined ? { prompt: null } : { prompt: null, priority }
  return (await inLane(taskId, async () => startTurn(taskId, message, false))).count
}

/** Why pending updates cannot queue behind the running turn, or null when none runs or they can. */
export function autoQueueBlocker(taskId: string): string | null {
  const session = live.get(taskId)
  if (session?.running !== true) {
    return null
  }
  if (!session.accepting) {
    return 'The running turn is starting or being cut short'
  }
  return session.autoQueued ? 'Updates already wait for the running turn to end' : null
}

/** Starts the session's process; a pending rewind makes it resume from the rewind point. */
async function sessionMessages(session: LiveSession, task: Task): Promise<AsyncIterable<SDKMessage>> {
  const { key, options } = await sessionStart(task, session.controller)
  session.startWith(key)
  if (task.session_id !== null) {
    moveSessionTo(CLAUDE_HOME, task.session_id, task.cwd)
  }
  return resumeSession(task.id, options, (sent) => {
    const started = startQuery({ prompt: session.openInput(), options: sent })
    session.attach(started)
    if (session.warm) {
      void watchSessionMcp(task.id, async () => session.mcpServerStatus())
    }
    return started
  })
}

/** A pending rewind or changed settings need a new process, which waits for background work. */
const needsNewProcess = async (session: LiveSession, task: Task) =>
  session.backgroundCount === 0 &&
  ((await rewinds.pending(task.id)) !== undefined || !session.startedWith(await setupKey(task)))

/** Records the prompt and returns it with the text the agent gets, prefaces included. */
async function openTurn(
  taskId: string,
  next: NextMessage,
  queued: boolean,
): Promise<{ content: UserContent; promptId: number }> {
  const { payload, text } = await promptFor(taskId, next, queued)
  const content = userContent(taskId, text, next.attachments ?? [])
  return { content, promptId: (await appendMessage(taskId, { kind: 'prompt', payload })).id }
}

async function send(taskId: string, session: LiveSession, next: NextMessage): Promise<void> {
  const { content, promptId } = await openTurn(taskId, next, false)
  session.send(content, promptId)
}

async function enqueue(taskId: string, session: LiveSession, next: NextMessage): Promise<void> {
  const { content, promptId } = await openTurn(taskId, next, true)
  session.enqueue(content, promptId, next.prompt === null ? (next.priority ?? 'later') : undefined)
}

/** Sends the first message that waited, which starts a turn, and queues the rest behind it. */
async function sendBacklog(taskId: string, session: LiveSession): Promise<void> {
  const [first, ...rest] = session.takeBacklog()
  if (first === undefined) {
    return
  }
  await send(taskId, session, first)
  for (const next of rest) {
    await enqueue(taskId, session, next)
  }
}

/** Settles each message a turn being cut short takes back; its prompt row follows in the lane. */
const takenBack = (taskId: string, session: LiveSession) => (uuid: string) => {
  const promptId = session.settle(uuid)
  if (promptId !== null) {
    inBackground(`session: task ${taskId}`, async () =>
      outsideLane(async () => inLane(taskId, async () => markQueued(taskId, promptId, 'removed'))),
    )
  }
}

/** Cuts the running turn short for a message, which goes out once the turn ended. */
function interruptWith(taskId: string, session: LiveSession, next: NextMessage): void {
  session.replaceBacklog(next)
  if (session.started) {
    void session.cutShort('replace', takenBack(taskId, session))
  }
}

/** Queues a message for the running turn, or holds it while the turn starts or is cut short. */
async function queueFor(taskId: string, session: LiveSession, next: NextMessage): Promise<void> {
  if (session.accepting) {
    await enqueue(taskId, session, next)
  } else {
    session.hold(next)
  }
}

/**
 * Hands a message to the task's session. It queues for a running turn or cuts it short when
 * asked, and waits in the backlog while the session starts or a turn is being cut short.
 */
async function startTurn(
  taskId: string,
  message: Omit<NextMessage, 'interrupted'>,
  interrupt: boolean,
): Promise<{ count: number; outcome: SendOutcome }> {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new HttpError(404, 'Task not found')
  }
  refuseArchived(task)
  const session = live.get(taskId)
  const running = session?.running === true
  const count = await checkSend(taskId, message, running)
  const next: NextMessage = { ...message, interrupted: running && interrupt }
  if (session === undefined || session.closed || (!running && (await needsNewProcess(session, task)))) {
    const held = interrupt ? [] : (session?.takeBacklog() ?? [])
    openSession(taskId, session, [...held, next])
  } else if (running && interrupt) {
    interruptWith(taskId, session, next)
  } else if (running) {
    await queueFor(taskId, session, next)
  } else {
    await send(taskId, session, next)
  }
  await setStatus(taskId, 'running')
  return { count, outcome: outcomeOf(running, interrupt) }
}

/**
 * Starts a session for the messages once the previous one has ended, after any that a session
 * which could not start kept; it follows in its own lane.
 */
function openSession(taskId: string, previous: LiveSession | undefined, backlog: NextMessage[]): void {
  const session = new LiveSession([...takeUnstarted(taskId), ...backlog])
  live.set(taskId, session)
  previous?.close()
  const opened = async () => outsideLane(async () => sessionOpening(taskId).then(async () => consume(taskId, session)))
  session.done = (previous?.done ?? Promise.resolve()).then(async () => outsideRequest(opened))
}

async function record(taskId: string, m: SDKMessage): Promise<string | null> {
  const outward = outwardToolUses(m)
  trackToolCalls(taskId, m)
  await appendMessage(taskId, { kind: 'sdk', payload: storedForm(await withTurnCost(taskId, m)) }, outward)
  await audit.outwardCalls(taskId, m, outward)
  await audit.classifierDenial(taskId, m)
  if (outward.length > 0) {
    await tasks.addOutward(taskId, outward.length)
  }
  await linkCreatedPrs(taskId, m, openQuerySince(taskId))
  if (m.type !== 'result' || !m.is_error) {
    return null
  }
  return m.subtype === 'success' ? m.result : m.subtype
}

const endStatus = (error: string | null): TaskStatus => (error === null ? 'idle' : 'error')

async function reportEnd(taskId: string, status: TaskStatus, lastError: string | null): Promise<void> {
  await tasks.endTurn(taskId, {
    status,
    last_error: status === 'error' ? lastError : null,
    asking: await turnAsks(taskId, status),
    closing_line: await closingLine(taskId),
  })
  publish(taskId, { type: 'status', status })
  for (const listener of turnEndListeners) {
    await listener(taskId, status)
  }
}

/**
 * A result ends the turn. Messages that waited for it to be cut short go out next; queued ones
 * Claude Code has not handed over yet start a turn of its own; otherwise the task stops working.
 * A notification turn ahead of the turn's message ends it only if the session then goes quiet.
 */
async function endTurn(taskId: string, session: LiveSession, m: SDKResultMessage, error: string | null): Promise<void> {
  for (const uuid of m.user_message_uuids ?? []) {
    await settleQueued(taskId, session, uuid, 'delivered')
  }
  if (!session.precedesOpener(m)) {
    await closeTurn(taskId, session, error)
    return
  }
  session.awaitOpener(OPENER_WAIT_MS, (still) => {
    const quiet = async () => (still() ? closeTurn(taskId, session, error) : undefined)
    inBackground(`session: task ${taskId}`, async () => inLane(taskId, quiet))
  })
}

async function closeTurn(taskId: string, session: LiveSession, error: string | null): Promise<void> {
  const ending = session.endTurn()
  if (ending !== null && session.backlog.length > 0) {
    await sendBacklog(taskId, session)
  } else if (session.queuedUuids.length > 0) {
    session.carryOn()
  } else {
    await reportEnd(taskId, ending === 'stop' ? 'stopped' : endStatus(error), error)
    session.closeWhenIdle(SESSION_IDLE_MS)
  }
  session.turnReported()
}

/** The task's own agent working again; messages of background subagents do not count. */
const startsWork = (m: SDKMessage) =>
  (m.type === 'assistant' && m.parent_tool_use_id === null) || (m.type === 'system' && m.subtype === 'init')

/** Follows the session: results end turns, and background work reporting back starts new ones. */
async function follow(taskId: string, session: LiveSession, m: SDKMessage, error: string | null): Promise<void> {
  if (m.type === 'result') {
    await endTurn(taskId, session, m, error)
  } else if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
    if (session.setBackground(m.tasks)) {
      publishSession(taskId)
    }
    session.closeWhenIdle(SESSION_IDLE_MS)
  } else if (startsWork(m) && session.resumeWork()) {
    await setStatus(taskId, 'running')
  }
}

/** Records a message of the session and follows it; returns the error a result reports. */
async function take(taskId: string, session: LiveSession, m: SDKMessage): Promise<string | null> {
  session.note(m)
  // Thinking token estimates come many per turn and nothing shows them.
  if ((m.type === 'system' && m.subtype === 'thinking_tokens') || (await followQueue(taskId, session, m))) {
    return null
  }
  const error = await record(taskId, await withContextWindow(m, async () => session.contextWindow()))
  await recordSessionStart(taskId, m, async () => session.mcpServerStatus())
  await follow(taskId, session, m, error)
  return error
}

/**
 * Reports how the session's last turn ended, or sends the messages that waited on it elsewhere.
 * A session that could not start keeps its messages for the next one, which the user opens.
 */
async function finish(taskId: string, session: LiveSession, lastError: string | null, failedStart: boolean) {
  const endedBySeti = session.closed
  session.close()
  for (const promptId of session.settleAll()) {
    await markQueued(taskId, promptId, 'removed')
  }
  if (live.get(taskId) !== session) {
    session.turnReported()
    return
  }
  live.delete(taskId)
  forgetToolCalls(taskId)
  const { running } = session
  session.endTurn()
  const backlog = session.takeBacklog()
  if (failedStart) {
    keepUnstarted(taskId, backlog)
    await reportEnd(taskId, 'error', lastError)
  } else if (backlog.length > 0 && (await tasks.get(taskId))) {
    openSession(taskId, session, backlog)
  } else if (running) {
    await reportEnd(taskId, endedBySeti ? 'stopped' : endStatus(lastError), lastError)
  }
  session.turnReported()
  publishSession(taskId)
  if (session.since !== null && (await hadRunningSubtask(taskId, session.since))) {
    await publishSubtasks(taskId, openQuerySince(taskId))
  }
}

/** Opens the process and sends the messages that waited for it; the SDK starts it on first read. */
async function startSession(taskId: string, session: LiveSession): Promise<AsyncIterable<SDKMessage>> {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new Error('Task was deleted before its session started')
  }
  const messagesOfSession = await sessionMessages(session, task)
  await sendBacklog(taskId, session)
  publishSession(taskId)
  session.closeWhenIdle(SESSION_IDLE_MS)
  return messagesOfSession
}

/** Follows one session to its end; each message is recorded and followed in the task's lane. */
async function consume(taskId: string, session: LiveSession): Promise<void> {
  let lastError: string | null = null
  let opened = false
  try {
    if (!session.closed && (session.warm || session.backlog.length > 0)) {
      const messagesOfSession = await inLane(taskId, async () => startSession(taskId, session))
      opened = true
      for await (const m of messagesOfSession) {
        const error = await inLane(taskId, async () => take(taskId, session, m))
        lastError = m.type === 'result' ? error : lastError
      }
    }
  } catch (e) {
    if (!session.closed) {
      const error = sessionError(e, opened)
      lastError = error
      await inLane(taskId, async () => appendMessage(taskId, { kind: 'seti', payload: { error } }))
    }
  } finally {
    const failedStart = !opened && lastError !== null
    await inLane(taskId, async () => finish(taskId, session, lastError, failedStart)).catch((e: unknown) => {
      process.stderr.write(`session: task ${taskId}: could not finish: ${e instanceof Error ? e.message : String(e)}\n`)
    })
  }
}

/** Interrupts the running turn and waits; queued messages go back, or on with `deliverQueued`. */
export async function stopTurn(taskId: string, { deliverQueued = false } = {}): Promise<void> {
  const session = live.get(taskId)
  if (session?.running !== true) {
    throw new HttpError(409, 'Task is not running')
  }
  const over = session.turnOver()
  session.backlog = deliverQueued ? session.backlog.filter((next) => next.prompt !== null) : []
  if (session.started) {
    await session.cutShort('stop', takenBack(taskId, session), deliverQueued)
  } else {
    session.close()
  }
  await over
}

/**
 * Opens a process for a task without an open one. It sends the messages a session that could not
 * start kept; with none, it waits for the next turn.
 */
export async function openWarmSession(taskId: string): Promise<void> {
  openSession(taskId, live.get(taskId), [])
  if (isRunning(taskId)) {
    await setStatus(taskId, 'running')
  }
}

/** Every open session with its task id. */
export const liveSessions = (): [string, LiveSession][] => [...live]

/** Asks the task's open session to stop one of its subagents or background commands. */
export const stopSessionTask = async (taskId: string, sdkTaskId: string): Promise<boolean> =>
  (await live.get(taskId)?.stopTask(sdkTaskId)) ?? false

/** Closes the task's session with everything running in it, and waits until it has ended. */
export async function endSession(taskId: string): Promise<void> {
  const session = live.get(taskId)
  if (!session) {
    return
  }
  session.takeBacklog()
  session.close()
  await session.done
}

onShutdown(async () => {
  for (const taskId of live.keys()) {
    await endSession(taskId)
  }
})

/** Takes a message back from Claude Code's queue before the agent reads it. */
export async function removeQueued(taskId: string, promptId: number): Promise<void> {
  const session = live.get(taskId)
  const uuid = session?.uuidOf(promptId) ?? null
  if (session === undefined || uuid === null) {
    throw new HttpError(409, 'That message is not waiting in the queue')
  }
  const cancelled = await session.cancelQueued(uuid)
  if (cancelled === null) {
    throw new HttpError(409, 'This Claude Code version cannot take back a queued message')
  }
  if (!cancelled) {
    throw new HttpError(409, 'The agent already picked up that message')
  }
  const settled = session.settle(uuid)
  if (settled !== null) {
    await inLane(taskId, async () => markQueued(taskId, settled, 'removed'))
  }
}

/** Closes the task's session if nothing runs in it; false when a turn or background work runs. */
export async function closeIdleSession(taskId: string): Promise<boolean> {
  const session = live.get(taskId)
  if (session !== undefined && !session.idle && !session.closed) {
    return false
  }
  await endSession(taskId)
  return true
}
