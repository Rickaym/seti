import { eventsOf, type EventOf, type JournalEntry, type Task, type TaskStatus } from '@seti/shared'
import { outsideRequest } from './access.js'
import { LiveSession, outcomeOf, type SendOutcome } from './agent-session.js'
import { inBackground, onShutdown } from './background.js'
import { CLAUDE_HOME, OPENER_WAIT_MS, SESSION_IDLE_MS } from './config.js'
import { tasks } from './db.js'
import type { LaunchPlan } from './launch-plan.js'
import type { NextMessage } from './next-message.js'
import { nodeLink } from './node-link.js'
import { followInput, settleQueued } from './queued-prompts.js'
import { resumeSession } from './rewind.js'
import type { InputContent, InputReport, RewindRequest, SessionMessage } from './runtimes/adapter.js'
import { adapterFor, DEFAULT_RUNTIME } from './runtimes/registry.js'
import { moveSessionTo } from './session-files.js'
import { realise } from './session-realise.js'
import type { SessionSpec } from './session-spec.js'
import { inLane, outsideLane } from './task-lane.js'
import { keepUnstarted, sessionError, takeUnstarted } from './unstarted.js'
import { userContent } from './user-content.js'
import { restoreMissingWorktrees } from './worktree-restore.js'

/** Each task's open Claude Code session, from its first message until it is closed. */
const live = new Map<string, LiveSession>()

type SessionChanged = Extract<JournalEntry, { type: 'session.changed' }>

/** The state of the session as the control plane mirrors it. */
export function changedEntry(session: LiveSession | undefined): SessionChanged {
  return {
    type: 'session.changed',
    open: session !== undefined && !session.closed,
    running: session?.running === true,
    accepting: session?.accepting === true,
    autoQueued: session?.autoQueued === true,
    background: session?.backgroundCount ?? 0,
  }
}

/** The last state each agent's session reported, so only a change is reported. */
const reported = new Map<string, string>()
const NOTHING = JSON.stringify(changedEntry(undefined))

/**
 * Reports the state of the task's session when it changed. The report goes out before this
 * returns, so the control plane's reads stay as fresh as the session itself.
 */
function reportState(taskId: string): void {
  const entry = changedEntry(live.get(taskId))
  const key = JSON.stringify(entry)
  if (key === (reported.get(taskId) ?? NOTHING)) {
    return
  }
  if (key === NOTHING) {
    reported.delete(taskId)
  } else {
    reported.set(taskId, key)
  }
  nodeLink.journal(taskId, entry).catch((e: unknown) => {
    process.stderr.write(`session: task ${taskId}: state not reported: ${e instanceof Error ? e.message : String(e)}\n`)
  })
}

async function publishSession(taskId: string): Promise<void> {
  const session = live.get(taskId)
  const background = session?.backgroundCount ?? 0
  await nodeLink.journal(taskId, { type: 'session.state', open: session !== undefined && !session.closed, background })
}

/** Hands a message to the task's session in its lane and says what it did. */
export async function sendTurn(
  taskId: string,
  message: Omit<NextMessage, 'interrupted'>,
  interrupt: boolean,
): Promise<SendOutcome> {
  return inLane(taskId, async () => startTurn(taskId, message, interrupt))
}

/**
 * Starts the session's process from the spec the control plane hands it; a pending rewind makes
 * it resume from the rewind point. A setting that changed while it started leaves no setup key,
 * so the next turn restarts.
 */
async function sessionReports(session: LiveSession, task: Task): Promise<AsyncIterable<Report>> {
  const taskId = task.id
  await restoreMissingWorktrees(task, async (error) => nodeLink.journal(taskId, { type: 'note', error }))
  const { spec, launch, key, rewind } = await nodeLink.ask(taskId, 'session.spec', {})
  // The control plane built the spec with startingSpec and the plan with launchPlan.
  const handed = spec as SessionSpec
  const options = await realise(handed, task, launch as LaunchPlan, session.controller)
  const now = await nodeLink.ask(taskId, 'setup.key', { spec })
  session.startWith(!now.rewind && now.key === key ? key : null)
  if (handed.resume !== null) {
    moveSessionTo(CLAUDE_HOME, handed.resume, handed.cwd)
  }
  const settle = async (id: number, state: 'applied' | 'refused', reason: string | null) =>
    nodeLink.journal(taskId, { type: 'rewind.settled', id, state, reason })
  const open = async (at: RewindRequest | null) => {
    const started = await adapterFor(DEFAULT_RUNTIME).open(options, session.openInput(), at)
    session.attach(started)
    await nodeLink.journal(taskId, { type: 'session.started', warm: session.warm })
    return started
  }
  return resumeSession(rewind, settle, open, () => session.controller.signal.aborted)
}

/** A pending rewind or changed settings need a new process, which waits for background work. */
async function needsNewProcess(session: LiveSession, taskId: string): Promise<boolean> {
  if (session.backgroundCount > 0) {
    return false
  }
  const now = await nodeLink.ask(taskId, 'setup.key', { spec: null })
  return now.rewind || !session.startedWith(now.key)
}

/** Records the prompt and returns it with the text the agent gets, prefaces included. */
async function openTurn(
  taskId: string,
  next: NextMessage,
  queued: boolean,
): Promise<{ content: InputContent; promptId: number }> {
  const { promptId, text } = await nodeLink.ask(taskId, 'prompt.open', { next, queued })
  return { content: userContent(taskId, text, next.attachments ?? []), promptId }
}

async function send(taskId: string, session: LiveSession, next: NextMessage): Promise<void> {
  const { content, promptId } = await openTurn(taskId, next, false)
  const first = session.since === null
  session.send(content, promptId, next.prompt === null ? 'updates' : 'user')
  if (first && live.get(taskId) === session) {
    await nodeLink.journal(taskId, { type: 'session.since', promptId })
  }
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
      outsideLane(async () =>
        inLane(taskId, async () => nodeLink.journal(taskId, { type: 'queued.settled', promptId, state: 'removed' })),
      ),
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
): Promise<SendOutcome> {
  const session = live.get(taskId)
  const running = session?.running === true
  const next: NextMessage = { ...message, interrupted: running && interrupt }
  if (session === undefined || session.closed || (!running && (await needsNewProcess(session, taskId)))) {
    const held = interrupt ? [] : (session?.takeBacklog() ?? [])
    openSession(taskId, session, [...held, next])
  } else if (running && interrupt) {
    interruptWith(taskId, session, next)
  } else if (running) {
    await queueFor(taskId, session, next)
  } else {
    await send(taskId, session, next)
  }
  await nodeLink.journal(taskId, { type: 'turn.started' })
  return outcomeOf(running, interrupt)
}

/**
 * Starts a session for the messages once the previous one has ended, after any that a session
 * which could not start kept; it follows in its own lane.
 */
function openSession(taskId: string, previous: LiveSession | undefined, backlog: NextMessage[]): void {
  const session = new LiveSession([...takeUnstarted(taskId), ...backlog])
  live.set(taskId, session)
  session.watch(() => {
    if (live.get(taskId) === session) {
      reportState(taskId)
    }
  })
  reportState(taskId)
  void nodeLink.journal(taskId, { type: 'session.opened' })
  previous?.close()
  const opening = async () => nodeLink.ask(taskId, 'session.opening', {})
  const opened = async () => outsideLane(async () => opening().then(async () => consume(taskId, session)))
  session.done = (previous?.done ?? Promise.resolve()).then(async () => outsideRequest(opened))
}

const endStatus = (error: string | null): TaskStatus => (error === null ? 'idle' : 'error')

type TurnEnded = EventOf<'turn.ended'>
/** A session's report as the session follows it. */
type Report = SessionMessage | InputReport

/** The error a turn's end reports, or null for a turn that ended well. */
const turnError = (end: TurnEnded): string | null => (end.status === 'error' ? (end.error ?? '') : null)

/**
 * A turn's end. Messages that waited for it to be cut short go out next; queued ones the runtime
 * has not handed over yet start a turn of its own; otherwise the task stops working. A turn for
 * background work ahead of the turn's message ends it only if the session then goes quiet.
 */
async function endTurn(taskId: string, session: LiveSession, m: SessionMessage, end: TurnEnded): Promise<void> {
  const error = turnError(end)
  for (const uuid of m.delivered) {
    await settleQueued(taskId, session, uuid, 'delivered')
  }
  if (!session.precedesOpener(end)) {
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
  if (session.restartCut) {
    session.close()
  } else if (ending !== null && session.backlog.length > 0) {
    await sendBacklog(taskId, session)
  } else if (session.queuedUuids.length > 0) {
    session.carryOn()
  } else {
    const status = ending === 'stop' ? 'stopped' : endStatus(error)
    await nodeLink.journal(taskId, { type: 'turn.ended', status, error })
    session.closeWhenIdle(SESSION_IDLE_MS)
  }
  session.turnReported()
}

/** The task's own agent working again; messages of background subagents do not count. */
const startsWork = (m: SessionMessage) => m.byAgent || m.events.some((event) => event.type === 'session.started')

/** Follows the session: turn ends end turns, and background work reporting back starts new ones. */
async function follow(taskId: string, session: LiveSession, m: SessionMessage, end: TurnEnded | undefined) {
  if (end !== undefined) {
    await endTurn(taskId, session, m, end)
  } else if (m.background !== undefined) {
    if (session.setBackground(m.background)) {
      await publishSession(taskId)
    }
    session.closeWhenIdle(SESSION_IDLE_MS)
  } else if (startsWork(m) && session.resumeWork()) {
    await nodeLink.journal(taskId, { type: 'turn.started' })
  }
}

/** What a session's report ends: a turn with its error, or nothing. */
type Taken = { ended: false } | { ended: true; error: string | null }

/** Records a report of the session and follows it; says whether it ended a turn, and its error. */
async function take(taskId: string, session: LiveSession, report: Report): Promise<Taken> {
  if (report.type === 'input') {
    session.heard()
    await followInput(taskId, session, report)
    return { ended: false }
  }
  session.note(report)
  await nodeLink.journal(taskId, { type: 'message', runtime: DEFAULT_RUNTIME, payload: report.raw })
  const [end] = eventsOf(report.events, 'turn.ended')
  await follow(taskId, session, report, end)
  return end === undefined ? { ended: false } : { ended: true, error: turnError(end) }
}

/**
 * Reports how the session's last turn ended, or sends the messages that waited on it elsewhere.
 * A session that could not start keeps its messages for the next one, which the user opens.
 */
async function finish(taskId: string, session: LiveSession, lastError: string | null, failedStart: boolean) {
  const endedBySeti = session.closed
  session.close()
  for (const promptId of session.settleAll()) {
    await nodeLink.journal(taskId, { type: 'queued.settled', promptId, state: 'removed' })
  }
  if (live.get(taskId) !== session) {
    session.turnReported()
    return
  }
  live.delete(taskId)
  reportState(taskId)
  await nodeLink.journal(taskId, { type: 'session.closed', since: session.since })
  const { running } = session
  session.endTurn()
  const backlog = session.takeBacklog()
  if (failedStart) {
    keepUnstarted(taskId, backlog)
    await nodeLink.journal(taskId, { type: 'turn.ended', status: 'error', error: lastError })
  } else if (!session.restartCut && backlog.length > 0 && (await tasks.get(taskId))) {
    openSession(taskId, session, backlog)
  } else if (running && !session.restartCut) {
    const status = endedBySeti ? 'stopped' : endStatus(lastError)
    await nodeLink.journal(taskId, { type: 'turn.ended', status, error: lastError })
  }
  session.turnReported()
  await publishSession(taskId)
}

/** Opens the process and sends the messages that waited for it; the SDK starts it on first read. */
async function startSession(taskId: string, session: LiveSession): Promise<AsyncIterable<Report>> {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new Error('Task was deleted before its session started')
  }
  const reports = await sessionReports(session, task)
  await sendBacklog(taskId, session)
  await publishSession(taskId)
  session.closeWhenIdle(SESSION_IDLE_MS)
  return reports
}

/** Follows one session to its end; each message is recorded and followed in the task's lane. */
async function consume(taskId: string, session: LiveSession): Promise<void> {
  let lastError: string | null = null
  let opened = false
  try {
    if (!session.closed && (session.warm || session.backlog.length > 0)) {
      const reports = await inLane(taskId, async () => startSession(taskId, session))
      opened = true
      for await (const report of reports) {
        const taken = await inLane(taskId, async () => take(taskId, session, report))
        lastError = taken.ended ? taken.error : lastError
      }
    }
  } catch (e) {
    if (!session.closed) {
      const error = sessionError(e, opened)
      lastError = error
      await inLane(taskId, async () => nodeLink.journal(taskId, { type: 'note', error }))
    }
  } finally {
    const failedStart = !opened && lastError !== null
    await inLane(taskId, async () => finish(taskId, session, lastError, failedStart)).catch((e: unknown) => {
      process.stderr.write(`session: task ${taskId}: could not finish: ${e instanceof Error ? e.message : String(e)}\n`)
    })
  }
}

/** Interrupts the running turn and waits; queued messages go back, or on with `deliverQueued`. */
export async function stopTurn(taskId: string, deliverQueued: boolean): Promise<boolean> {
  const session = live.get(taskId)
  if (session?.running !== true) {
    return false
  }
  const over = session.turnOver()
  session.backlog = deliverQueued ? session.backlog.filter((next) => next.prompt !== null) : []
  if (session.started) {
    await session.cutShort('stop', takenBack(taskId, session), deliverQueued)
  } else {
    session.close()
  }
  await over
  return true
}

/**
 * Opens a process for a task without an open one. It sends the messages a session that could not
 * start kept; with none, it waits for the next turn.
 */
export async function openWarmSession(taskId: string): Promise<void> {
  openSession(taskId, live.get(taskId), [])
  if (live.get(taskId)?.running === true) {
    await nodeLink.journal(taskId, { type: 'turn.started' })
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

/** Closes the task's session if nothing runs in it; false when a turn or background work runs. */
export async function closeIdleSession(taskId: string): Promise<boolean> {
  const session = live.get(taskId)
  if (session !== undefined && !session.idle && !session.closed) {
    return false
  }
  await endSession(taskId)
  return true
}
