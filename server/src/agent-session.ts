import { randomUUID, type UUID } from 'node:crypto'
import type {
  McpServerStatus,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { PromptAttachment } from '@seti/shared'
import type { UserContent } from './user-content.js'

/** How long an interrupted turn may take to end before its session is closed. */
const INTERRUPT_GRACE_MS = 5000
/** How long taking a message back waits for Claude Code to report that it has the message. */
const ARRIVAL_WAIT_MS = 2000
/** How long reading the context window may take before a compaction is stored without it. */
const CONTEXT_WAIT_MS = 3000

type BackgroundTasks = Extract<SDKMessage, { subtype: 'background_tasks_changed' }>['tasks']

/** The user messages of one query, handed over as they come until the queue is closed. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly waiting: SDKUserMessage[]
  private readonly sent: SDKUserMessage[]
  private wake: (() => void) | null = null
  private closed = false

  constructor(replayed: readonly SDKUserMessage[] = []) {
    this.waiting = [...replayed]
    this.sent = [...replayed]
  }

  push(content: UserContent, uuid: UUID, priority?: SDKUserMessage['priority']): void {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid,
      ...(priority === undefined ? {} : { priority }),
      // Claude Code joins only a person's "now" message to the running turn; others end it.
      ...(priority === 'now' ? { origin: { kind: 'human' } } : {}),
    }
    this.waiting.push(message)
    this.sent.push(message)
    this.wakeUp()
  }

  close(): void {
    this.closed = true
    this.wakeUp()
  }

  /** Closes this queue and returns one that hands over the same messages again. */
  replay(): InputQueue {
    this.close()
    return new InputQueue(this.sent)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.waiting.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) {
        return
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private wakeUp(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

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

/** When Claude Code hands a message sent during a turn over: now, at the next step, or after it. */
export type QueuePriority = NonNullable<SDKUserMessage['priority']>

/** A message waiting for its session to start, or for the turn being cut short to end. */
export interface NextMessage {
  prompt: string | null
  /** Files sent with the prompt; images among them go to the agent with the text. */
  attachments?: PromptAttachment[]
  /** It cut the running turn short, so it goes out once that turn ended. */
  interrupted: boolean
  /** The user's last message sent again; refused while a turn runs. */
  retry?: boolean
  /** The browser's id for the send, which its prompt row carries. */
  client_id?: string
  /** Who wrote it when not the user, such as the EA starting an agent; the agent is told. */
  from?: string
  /**
   * For updates with no user text: reach a running turn at its next step, or now for a person's
   * message, which moves the turn's running commands to the background; not after the turn.
   */
  priority?: Exclude<QueuePriority, 'later'>
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

/** The SDK sends cancel_async_message from this method, which its Query type does not declare. */
interface CancelsQueued {
  cancelAsyncMessage: (uuid: string) => Promise<unknown>
}

const cancelsQueued = (query: object): query is CancelsQueued =>
  'cancelAsyncMessage' in query && typeof query.cancelAsyncMessage === 'function'

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
  private query: Query | null = null
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

  constructor(backlog: NextMessage[]) {
    this.backlog = backlog
    this.running = backlog.length > 0
    this.warm = backlog.length === 0
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

  /** The prompt for a new query; a query started over gets the messages sent so far again. */
  openInput(): AsyncIterable<SDKUserMessage> {
    if (this.query !== null) {
      this.input = this.input.replay()
    }
    return this.input
  }

  attach(query: Query): void {
    this.query = query
    if (this.closed) {
      query.close()
    }
  }

  /** How the process's MCP servers connected; null before it started or once it ended. */
  async mcpServerStatus(): Promise<McpServerStatus[] | null> {
    return this.query === null || this.closed ? null : this.query.mcpServerStatus()
  }

  /** The context window Claude Code measures usage against; null when it cannot say in time. */
  async contextWindow(): Promise<number | null> {
    const query = this.query
    if (query === null || this.closed || typeof query.getContextUsage !== 'function') {
      return null
    }
    const late = new Promise<null>((resolve) => {
      setTimeout(resolve, CONTEXT_WAIT_MS, null).unref()
    })
    const usage = query.getContextUsage({ detail: 'summary' }).then(
      (u) => u.rawMaxTokens,
      () => null,
    )
    return Promise.race([usage, late])
  }

  /** Hands the running process new permission rules; Claude Code applies them to its next call. */
  async applyPermissions(permissions: { allow: string[]; ask: string[]; deny: string[] }): Promise<void> {
    if (this.query !== null && !this.closed && typeof this.query.applyFlagSettings === 'function') {
      await this.query.applyFlagSettings({ permissions })
    }
  }

  /** The running process's controls; null before it starts or once it closed. */
  get openQuery(): Query | null {
    return this.closed ? null : this.query
  }

  startWith(setup: string | null): void {
    this.setup = setup
  }

  startedWith(setup: string): boolean {
    return this.setup === setup
  }

  /** Sends a message into the session, which starts a turn. */
  send(content: UserContent, promptId: number): void {
    this.since ??= promptId
    this.heardAt = Date.now()
    this.cancelIdle()
    this.running = true
    this.started = true
    this.ending = null
    this.opener = randomUUID()
    this.input.push(content, this.opener)
  }

  /**
   * A result of a turn Claude Code ran for a background notification before it read the message
   * that started the running turn, as a resumed session does for work the last process left.
   */
  precedesOpener(result: SDKResultMessage): boolean {
    if (this.opener === null || result.origin?.kind !== 'task-notification') {
      return false
    }
    const answered = result.user_message_uuids ?? [result.user_message_uuid]
    return !answered.includes(this.opener)
  }

  /** The session wrote a message of a turn at work, so one waiting for its opener still goes. */
  heard(): void {
    this.said += 1
    this.heardAt = Date.now()
    this.retrying = null
    this.stopOpenerWait()
  }

  /** Starts the quiet clock again, as when the user answered what the session waited on. */
  restartQuiet(): void {
    this.heardAt = Date.now()
  }

  /** Notes a message of the session: work it reports, or Claude Code retrying the API. */
  note(m: SDKMessage): void {
    if (m.type !== 'system') {
      this.heard()
    } else if (m.subtype === 'api_retry') {
      this.retrying = m.error_status === null ? m.error : `${m.error} (${String(m.error_status)})`
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
  enqueue(content: UserContent, promptId: number, priority?: QueuePriority): void {
    const uuid = randomUUID()
    let arrive = (): void => undefined
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve
    })
    this.queued.set(uuid, { promptId, later: priority === 'later', written: priority === undefined, arrived, arrive })
    this.input.push(content, uuid, priority)
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
    return entry?.promptId ?? null
  }

  /** Forgets every queued message, for a session that ended, and returns their prompt ids. */
  settleAll(): number[] {
    const entries = [...this.queued.values()]
    this.queued.clear()
    for (const entry of entries) {
      entry.arrive()
    }
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
    const query = this.query
    const entry = this.queued.get(uuid)
    if (query === null || !cancelsQueued(query)) {
      return null
    }
    if (entry === undefined) {
      return false
    }
    await within(entry.arrived, ARRIVAL_WAIT_MS)
    if (this.closed) {
      return null
    }
    return this.queued.has(uuid) && (await query.cancelAsyncMessage(uuid)) === true
  }

  /**
   * Takes back the messages still in Claude Code's queue, which would survive an interrupt, then
   * cuts the running turn short unless it ended meanwhile. Messages sent until then are held.
   * With `keepWritten`, written messages stay queued and start the next turn.
   */
  async cutShort(ending: TurnEnding, takenBack: (uuid: string) => void, keepWritten = false): Promise<void> {
    this.ending = ending
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
    if (this.interrupting) {
      return
    }
    this.interrupting = true
    const query = this.query
    if (query === null) {
      this.close()
      return
    }
    const timer = setTimeout(() => {
      this.close()
    }, INTERRUPT_GRACE_MS)
    void this.turnOver().then(() => {
      clearTimeout(timer)
    })
    query.interrupt().catch(() => {
      this.close()
    })
  }

  /** Background work reporting back started a turn; false when one was already running. */
  resumeWork(): boolean {
    if (this.running) {
      return false
    }
    this.carryOn()
    return true
  }

  /** Keeps the session running into the turn Claude Code starts for queued messages. */
  carryOn(): void {
    this.running = true
    this.cancelIdle()
  }

  /** Marks the running turn over and returns how it was being ended, if it was. */
  endTurn(): TurnEnding | null {
    const { ending } = this
    this.running = false
    this.ending = null
    this.opener = null
    this.stopOpenerWait()
    this.interrupting = false
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
  setBackground(tasks: BackgroundTasks): boolean {
    const before = this.background.size
    this.background = new Set(tasks.filter((task) => task.ambient !== true).map((task) => task.task_id))
    return this.background.size !== before
  }

  async stopTask(sdkTaskId: string): Promise<boolean> {
    if (this.closed || this.query === null) {
      return false
    }
    await this.query.stopTask(sdkTaskId)
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
    this.cancelIdle()
    this.stopOpenerWait()
    this.input.close()
    this.query?.close()
    this.controller.abort()
  }

  private cancelIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
