import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { outsideRequest } from '../access.js'
import { LiveSession } from '../agent-session.js'
import { onShutdown } from '../background.js'
import { CLAUDE_HOME, SESSION_IDLE_MS } from '../config.js'
import type { NextMessage } from '../next-message.js'
import { startQuery } from '../sdk-query.js'
import type { SessionDecisions } from '../session-decisions.js'
import { moveSessionTo } from '../session-files.js'
import { realiseSpec } from '../session-realise.js'
import { inLane, outsideLane } from '../task-lane.js'
import { keepUnstarted, sessionError, takeUnstarted } from '../unstarted.js'
import { sessionControls } from './controls.js'
import type { ControlPort, RestartCheck, SessionCommands } from './port.js'
import { resumeSession } from './resume.js'
import { endStatus, interruptWith, queueFor, send, sendBacklog, take, takenBack, type Host, type Ref } from './turns.js'

/** Takes the messages a session that could not start kept, for the session about to open. */
function unstartedFor(host: Host, taskId: string): NextMessage[] {
  const kept = takeUnstarted(taskId)
  if (kept !== null) {
    host.port.unstarted(taskId, null)
  }
  return kept ?? []
}

/** Starts the session's process; a pending rewind makes it resume from the rewind point. */
async function sessionMessages({ host, taskId, session }: Ref): Promise<AsyncIterable<SDKMessage>> {
  const { key, spec, rewind } = await host.port.sessionSpec(taskId)
  const options = await realiseSpec(spec, session.controller, host.decisions)
  session.startWith(key)
  if (spec.task.session_id !== null) {
    moveSessionTo(CLAUDE_HOME, spec.task.session_id, spec.task.cwd)
  }
  const open = (sent: typeof options) => {
    const started = startQuery({ prompt: session.openInput(), options: sent })
    session.attach(started)
    if (session.warm) {
      host.port.warmOpened(taskId)
    }
    return started
  }
  return resumeSession(rewind, options, open, async (id, refused) => host.port.rewound(taskId, id, refused))
}

/** Opens the process and sends the messages that waited for it; the SDK starts it on first read. */
async function startSession(ref: Ref): Promise<AsyncIterable<SDKMessage>> {
  const messagesOfSession = await sessionMessages(ref)
  await sendBacklog(ref)
  ref.host.port.sessionChanged(ref.taskId)
  ref.session.closeWhenIdle(SESSION_IDLE_MS)
  return messagesOfSession
}

/** How a session ended: the error it reported, whether it never started, whether Seti closed it. */
interface Ending {
  lastError: string | null
  failedStart: boolean
  endedBySeti: boolean
}

/** What a session's end leaves to do: report its turn's end, or open the next for its backlog. */
async function afterEnd(ref: Ref, { lastError, failedStart, endedBySeti }: Ending): Promise<void> {
  const { host, taskId, session } = ref
  const { running } = session
  session.endTurn()
  const backlog = session.takeBacklog()
  if (failedStart) {
    keepUnstarted(taskId, backlog)
    host.port.unstarted(taskId, { first: backlog[0] === undefined ? null : (backlog[0].prompt ?? '') })
    await host.port.turnEnded(taskId, 'error', lastError)
  } else if (!session.restartCut && backlog.length > 0 && (await host.port.taskExists(taskId))) {
    openSession(host, taskId, session, backlog)
  } else if (running && !session.restartCut) {
    await host.port.turnEnded(taskId, endedBySeti ? 'stopped' : endStatus(lastError), lastError)
  }
}

/**
 * Reports how the session's last turn ended, or sends the messages that waited on it elsewhere.
 * A session that could not start keeps its messages for the next one, which the user opens.
 */
async function finish(ref: Ref, lastError: string | null, failedStart: boolean): Promise<void> {
  const { host, taskId, session } = ref
  const endedBySeti = session.closed
  session.close()
  for (const promptId of session.settleAll()) {
    await host.port.queued(taskId, promptId, 'removed')
  }
  if (host.live.get(taskId) !== session) {
    session.turnReported()
    return
  }
  host.live.delete(taskId)
  host.port.view(taskId, null)
  host.port.sessionEnded(taskId)
  await afterEnd(ref, { lastError, failedStart, endedBySeti })
  session.turnReported()
  await host.port.sessionClosed(taskId, session.since)
}

/** Follows one session to its end; each message is recorded and followed in the task's lane. */
async function consume(ref: Ref): Promise<void> {
  const { host, taskId, session } = ref
  let lastError: string | null = null
  let opened = false
  try {
    if (!session.closed && (session.warm || session.backlog.length > 0)) {
      const messagesOfSession = await inLane(taskId, async () => startSession(ref))
      opened = true
      for await (const m of messagesOfSession) {
        const error = await inLane(taskId, async () => take(ref, m))
        lastError = m.type === 'result' ? error : lastError
      }
    }
  } catch (e) {
    if (!session.closed) {
      const error = sessionError(e, opened)
      lastError = error
      await inLane(taskId, async () => host.port.note(taskId, error))
    }
  } finally {
    const failedStart = !opened && lastError !== null
    await inLane(taskId, async () => finish(ref, lastError, failedStart)).catch((e: unknown) => {
      process.stderr.write(`session: task ${taskId}: could not finish: ${e instanceof Error ? e.message : String(e)}\n`)
    })
  }
}

/**
 * Starts a session for the messages once the previous one has ended, after any that a session
 * which could not start kept; it follows in its own lane.
 */
function openSession(host: Host, taskId: string, previous: LiveSession | undefined, backlog: NextMessage[]): void {
  const session = new LiveSession([...unstartedFor(host, taskId), ...backlog])
  session.onChange = () => {
    if (host.live.get(taskId) === session) {
      host.port.view(taskId, session.view())
    }
  }
  host.live.set(taskId, session)
  host.port.view(taskId, session.view())
  previous?.close()
  const ref = { host, taskId, session }
  const opened = async () => outsideLane(async () => host.port.opening(taskId).then(async () => consume(ref)))
  session.done = (previous?.done ?? Promise.resolve()).then(async () => outsideRequest(opened))
}

/** A pending rewind or changed settings need a new process, which waits for background work. */
const needsNewProcess = (session: LiveSession, check: RestartCheck | null) =>
  session.backgroundCount === 0 &&
  check !== null &&
  (check.rewind || (check.key !== null && !session.startedWith(check.key)))

interface StartRequest {
  message: Omit<NextMessage, 'interrupted'>
  interrupt: boolean
}

/**
 * Hands a message to the task's session. It queues for a running turn or cuts it short when
 * asked, and waits in the backlog while the session starts or a turn is being cut short.
 */
async function start(host: Host, taskId: string, request: StartRequest, check: RestartCheck | null): Promise<void> {
  const { message, interrupt } = request
  const session = host.live.get(taskId)
  const running = session?.running === true
  const next: NextMessage = { ...message, interrupted: running && interrupt }
  if (session === undefined || session.closed || (!running && needsNewProcess(session, check))) {
    const held = interrupt ? [] : (session?.takeBacklog() ?? [])
    openSession(host, taskId, session, [...held, next])
  } else if (running && interrupt) {
    interruptWith({ host, taskId, session }, next)
  } else if (running) {
    await queueFor({ host, taskId, session }, next)
  } else {
    await send({ host, taskId, session }, next)
  }
}

/** Interrupts the running turn and waits; queued messages go back, or on with `deliverQueued`. */
async function stop(host: Host, taskId: string, deliverQueued: boolean): Promise<void> {
  const session = host.live.get(taskId)
  if (session?.running !== true) {
    return
  }
  const over = session.turnOver()
  session.backlog = deliverQueued ? session.backlog.filter((next) => next.prompt !== null) : []
  if (session.started) {
    await session.cutShort('stop', takenBack({ host, taskId, session }), deliverQueued)
  } else {
    session.close()
  }
  await over
}

/** Closes the task's session with everything running in it, and waits until it has ended. */
async function end(host: Host, taskId: string): Promise<void> {
  const session = host.live.get(taskId)
  if (!session) {
    return
  }
  session.takeBacklog()
  session.close()
  await session.done
}

/** Runs sessions in this process and reports to Seti's records side through `port`. */
export function createSessionHost(port: ControlPort, decisions: SessionDecisions): SessionCommands {
  const host: Host = { live: new Map(), port, decisions }
  onShutdown(async () => {
    for (const taskId of host.live.keys()) {
      await end(host, taskId)
    }
  })
  return {
    start: async (taskId, message, interrupt, check) => start(host, taskId, { message, interrupt }, check),
    openWarm: (taskId) => {
      openSession(host, taskId, host.live.get(taskId), [])
    },
    stop: async (taskId, deliverQueued) => stop(host, taskId, deliverQueued),
    end: async (taskId) => end(host, taskId),
    closeIdle: async (taskId) => {
      const session = host.live.get(taskId)
      if (session !== undefined && !session.idle && !session.closed) {
        return false
      }
      await end(host, taskId)
      return true
    },
    stopTask: async (taskId, sdkTaskId) => (await host.live.get(taskId)?.stopTask(sdkTaskId)) ?? false,
    mcpStatus: async (taskId) => (await host.live.get(taskId)?.mcpServerStatus()) ?? null,
    ...sessionControls(host.live),
  }
}
