import { randomUUID, type UUID } from 'node:crypto'
import { eventsOf, type EventOf } from '@seti/shared'
import { InputQueue } from './input-queue.js'
import type { NextMessage } from './next-message.js'
import type { InputContent, InputPriority, SessionInput, SessionMessage } from './runtimes/adapter.js'
import type { DefaultSession, DefaultShapes } from './runtimes/registry.js'
import type { CutKind } from './store/restart.js'

/** How long an interrupted turn may take to end before its session is closed. */
const INTERRUPT_GRACE_MS = 5000
/** How long taking a message back waits for Claude Code to report that it has the message. */
const ARRIVAL_WAIT_MS = 2000

/** Why the running turn is being cut short: Stop, or a message sent with the interrupt flag. */
type TurnEnding = 'stop' | 'replace'

/** What sending a message did: started a turn, queued it for the running one, or cut that short. */
export type SendOutcome = 'started' | 'queued' | 'interrupted'

export function outcomeOf(running: boolean, interrupt: boolean): SendOutcome {
  if (!running) {
    return 'started'
  }
  return interrupt ? 'interrupted' : 'queued'
}

/** A message Claude Code holds in its queue until the agent can read it. */
interface Queued {
  promptId: number
  /** Updates that wait for the running turn to end and start one of their own. */
  later: boolean
  /** A message with text someone wrote, rather than an update. */
  written: boolean
  /** Resolves once Claude Code reports the message in its queue, or the message settled. */
  arrived: Promise<void>
  arrive: () => void
}

async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ])
  clearTimeout(timer)
}

/** One long-lived Claude Code process of a task, fed user messages through a streaming prompt. */
export class LiveSession {
  readonly controller = new AbortController()
  /** Id of the first prompt the session sent, once recorded. */
  since: number | null = null
  /** A turn is in progress, or the first message waits to be sent. */
  running: boolean
  /** Started with no message, so its MCP servers connect before the next turn. */
  readonly warm: boolean
  /** The first message went out, so a turn can be interrupted instead of dropped. */
  started = false
  ending: TurnEnding | null = null
  /** Messages waiting for the session to start or for the turn being cut short to end, in order. */
  backlog: NextMessage[]
  /** Seti ended the session on purpose, so errors the ending causes are not reported. */
  closed = false
  /** Resolves once the session has ended and its messages are recorded. */
  done: Promise<void> = Promise.resolve()
  private input = new InputQueue()
  private runtime: DefaultSession | null = null
  private interrupting = false
  private background = new Set<string>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly turnWaiters: (() => void)[] = []
  /** Messages sent during a turn that Claude Code has not handed to the agent, by their uuid. */
  private readonly queued = new Map<string, Queued>()
  /** Settings the process was started with; a change needs a new process. */
  private setup: string | null = null
  /** Uuid of the message that started the running turn, until a result answers it. */
  private opener: UUID | null = null
  /** How many messages of a turn at work the session wrote, so a wait can tell it said more. */
  private said = 0
  /** When the session last wrote a message of work, or its turn started. */
  heardAt = Date.now()
  /** Why Claude Code retries the API, since its last message of work; null when it does not. */
  retrying: string | null = null
  private openerTimer: ReturnType<typeof setTimeout> | null = null
  /** What started the running turn: a written message, updates, or background work. */
  turnKind: CutKind = 'user'
  /** Seti is stopping, so the next start resumes the turn instead of this one reporting its end. */
  restartCut = false
  private changed: () => void = () => undefined

  constructor(backlog: NextMessage[]) {
    this.backlog = backlog
    this.running = backlog.length > 0
    this.warm = backlog.length === 0
  }

  /** Calls `listener` after each change of whether it runs, accepts, queues updates or is open. */
  watch(listener: () => void): void {
    this.changed = listener
  }

  /** Background subagents and commands still running. */
  get backgroundCount(): number {
    return this.background.size
  }

  /** Nothing runs or waits in the session, so closing it loses nothing. */
  get idle(): boolean {
    return !this.running && !this.closed && this.backlog.length === 0 && this.background.size === 0
  }

  /** A turn runs that Claude Code can queue messages for; otherwise they wait in the backlog. */
  get accepting(): boolean {
    return this.running && this.started && this.ending === null && !this.closed
  }

  /** Uuids of the messages still in Claude Code's queue, oldest first. */
  get queuedUuids(): string[] {
    return [...this.queued.keys()]
  }

  /** Updates without a user message already wait for the running turn to end. */
  get autoQueued(): boolean {
    return [...this.queued.values()].some((entry) => entry.later)
  }

  takeBacklog(): NextMessage[] {
    return this.backlog.splice(0)
  }

  /** Keeps a message until the session starts or the turn being cut short ends. */
  hold(next: NextMessage): void {
    this.backlog.push(next)
  }

  /** A message that interrupts the turn replaces any that waited for it. */
  replaceBacklog(next: NextMessage): void {
    this.backlog = [next]
  }

  /** The inputs of a new process; a process started over gets the messages sent so far again. */
  openInput(): AsyncIterable<SessionInput> {
    if (this.runtime !== null) {
      this.input = this.input.replay()
    }
    return this.input
  }

  attach(runtime: DefaultSession): void {
    this.runtime = runtime
    if (this.closed) {
      runtime.close()
    }
  }

  /** How the process's MCP servers connected; null before it started or once it ended. */
  async mcpServerStatus(): Promise<DefaultShapes['toolServer'][] | null> {
    const servers = this.closed ? undefined : this.runtime?.toolServers
    return servers === undefined ? null : servers()
  }

  /** Hands the running process new permission rules; the runtime applies them to its next call. */
  async applyPermissions(permissions: DefaultShapes['policy']): Promise<void> {
    const apply = this.closed ? undefined : this.runtime?.setPolicy
    if (apply !== undefined) {
      await apply(permissions)
    }
  }

  /** The running process's controls; null before it starts or once it closed. */
  get openRuntime(): DefaultSession | null {
    return this.closed ? null : this.runtime
  }

  startWith(setup: string | null): void {
    this.setup = setup
  }

  startedWith(setup: string): boolean {
    return this.setup === setup
  }

  /** Sends a message into the session, which starts a turn. */
  send(content: InputContent, promptId: number, kind: CutKind = 'user'): void {
    this.turnKind = kind
    this.since ??= promptId
    this.heardAt = Date.now()
    this.cancelIdle()
    this.running = true
    this.started = true
    this.ending = null
    this.opener = randomUUID()
    this.input.push(content, this.opener)
    this.changed()
  }

  /**
   * The end of a turn the runtime ran for background work before it read the message that
   * started the running turn, as a resumed session does for work the last process left.
   */
  precedesOpener(end: EventOf<'turn.ended'>): boolean {
    if (this.opener === null || end.cause !== 'background') {
      return false
    }
    return !end.answered.includes(this.opener)
  }

  /** The session wrote a message of a turn at work, so one waiting for its opener still goes. */
  heard(): void {
    this.said += 1
    this.heardAt = Date.now()
    this.retrying = null
    this.stopOpenerWait()
  }

  /** Starts the quiet clock again, as when the user answered what the session waited on. */
  restartQuiet(at = Date.now()): void {
    this.heardAt = at
  }

  /** Notes a message of the session: work it reports, or the runtime retrying the API. */
  note(m: SessionMessage): void {
    if (m.work) {
      this.heard()
      return
    }
    const retry = eventsOf(m.events, 'notice').find((event) => event.code === 'api_retry')
    if (retry !== undefined) {
      this.retrying = retry.status === undefined ? retry.text : `${retry.text} (${String(retry.status)})`
    }
  }

  /**
   * Calls `quiet` after `ms` with a check that the session said nothing since and the opener is
   * still unanswered, as when Claude Code drops the message after a notification turn.
   */
  awaitOpener(ms: number, quiet: (still: () => boolean) => void): void {
    this.stopOpenerWait()
    const { said } = this
    this.openerTimer = setTimeout(() => {
      this.openerTimer = null
      quiet(() => this.said === said && this.opener !== null && !this.closed)
    }, ms)
    this.openerTimer.unref()
  }

  private stopOpenerWait(): void {
    if (this.openerTimer !== null) {
      clearTimeout(this.openerTimer)
      this.openerTimer = null
    }
  }

  /**
   * Sends a message during a turn, which Claude Code queues. The user's messages join the running
   * turn at its next step; updates wait for the turn to end unless they ask for sooner.
   */
  enqueue(content: InputContent, promptId: number, priority?: InputPriority): void {
    const uuid = randomUUID()
    let arrive = (): void => undefined
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve
    })
    this.queued.set(uuid, { promptId, later: priority === 'later', written: priority === undefined, arrived, arrive })
    this.input.push(content, uuid, priority)
    this.changed()
  }

  /** Claude Code reported the message in its queue, where it can be taken back. */
  arrived(uuid: string): void {
    this.queued.get(uuid)?.arrive()
  }

  /** Forgets a message Claude Code took off its queue and returns its prompt id, if it was queued. */
  settle(uuid: string): number | null {
    const entry = this.queued.get(uuid)
    entry?.arrive()
    this.queued.delete(uuid)
    this.changed()
    return entry?.promptId ?? null
  }

  /** Forgets every queued message, for a session that ended, and returns their prompt ids. */
  settleAll(): number[] {
    const entries = [...this.queued.values()]
    this.queued.clear()
    for (const entry of entries) {
      entry.arrive()
    }
    this.changed()
    return entries.map((entry) => entry.promptId)
  }

  uuidOf(promptId: number): string | null {
    return [...this.queued].find(([, entry]) => entry.promptId === promptId)?.[0] ?? null
  }

  /**
   * Asks Claude Code to drop a queued message once it has it; null when this SDK cannot, false
   * when the agent already took it.
   */
  async cancelQueued(uuid: string): Promise<boolean | null> {
    const retract = this.runtime?.retract
    const entry = this.queued.get(uuid)
    if (retract === undefined) {
      return null
    }
    if (entry === undefined) {
      return false
    }
    await within(entry.arrived, ARRIVAL_WAIT_MS)
    if (this.closed) {
      return null
    }
    return this.queued.has(uuid) && (await retract(uuid))
  }

  /**
   * Takes back the messages still in Claude Code's queue, which would survive an interrupt, then
   * cuts the running turn short unless it ended meanwhile. Messages sent until then are held.
   * With `keepWritten`, written messages stay queued and start the next turn.
   */
  async cutShort(ending: TurnEnding, takenBack: (uuid: string) => void, keepWritten = false): Promise<void> {
    this.ending = ending
    this.changed()
    const uuids = [...this.queued].filter(([, entry]) => !(keepWritten && entry.written)).map(([uuid]) => uuid)
    await Promise.all(
      uuids.map(async (uuid) => {
        if ((await this.cancelQueued(uuid).catch(() => false)) === true) {
          takenBack(uuid)
        }
      }),
    )
    if (this.running && this.ending === ending) {
      this.interrupt(ending)
    }
  }

  /** Cuts the running turn short; a session that cannot be interrupted in time is closed. */
  interrupt(ending: TurnEnding): void {
    this.ending = ending
    this.changed()
    if (this.interrupting) {
      return
    }
    this.interrupting = true
    const runtime = this.runtime
    if (runtime === null) {
      this.close()
      return
    }
    const timer = setTimeout(() => {
      this.close()
    }, INTERRUPT_GRACE_MS)
    void this.turnOver().then(() => {
      clearTimeout(timer)
    })
    runtime.interrupt().catch(() => {
      this.close()
    })
  }

  /** Ends the running turn as Seti stops: interrupted where Claude Code can, else closed. */
  cutForRestart(): void {
    this.restartCut = true
    this.backlog = []
    if (this.started && this.runtime !== null) {
      this.interrupt('stop')
    } else {
      this.close()
    }
  }

  /** Background work reporting back started a turn; false when one was already running. */
  resumeWork(): boolean {
    if (this.running) {
      return false
    }
    this.turnKind = 'wake'
    this.carryOn()
    return true
  }

  /** Keeps the session running into the turn Claude Code starts for queued messages. */
  carryOn(): void {
    this.running = true
    this.cancelIdle()
    this.changed()
  }

  /** Marks the running turn over and returns how it was being ended, if it was. */
  endTurn(): TurnEnding | null {
    const { ending } = this
    this.running = false
    this.ending = null
    this.opener = null
    this.stopOpenerWait()
    this.interrupting = false
    this.changed()
    return ending
  }

  /** Resolves callers waiting for the running turn to end, once its end is reported. */
  turnReported(): void {
    for (const resolve of this.turnWaiters.splice(0)) {
      resolve()
    }
  }

  async turnOver(): Promise<void> {
    return new Promise((resolve) => {
      this.turnWaiters.push(resolve)
    })
  }

  /** Replaces the set of live background work; true when its count changed. */
  setBackground(jobs: readonly string[]): boolean {
    const before = this.background.size
    this.background = new Set(jobs)
    this.changed()
    return this.background.size !== before
  }

  async stopTask(sdkTaskId: string): Promise<boolean> {
    const stop = this.closed ? undefined : this.runtime?.stopBackground
    if (stop === undefined) {
      return false
    }
    await stop(sdkTaskId)
    return true
  }

  /** Closes the session after `ms` unless it gets work first. */
  closeWhenIdle(ms: number): void {
    this.cancelIdle()
    if (!this.idle) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.idle) {
        this.close()
      }
    }, ms)
    this.idleTimer.unref()
  }

  /** Ends the process and everything running in it. */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.changed()
    this.cancelIdle()
    this.stopOpenerWait()
    this.input.close()
    this.runtime?.close()
    this.controller.abort()
  }

  private cancelIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
