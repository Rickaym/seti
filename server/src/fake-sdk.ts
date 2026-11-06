import type { McpServerStatus, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** Messages a test hands to the runner; only the fields the runner reads need to be real. */
type FakeMessage = Record<string, unknown> & { type: string }

let counter = 0

/** A message of the fake session, with the ids every SDK message carries. */
export function fakeMessage(type: string, extra: Record<string, unknown> = {}): FakeMessage {
  counter += 1
  return {
    type,
    session_id: 'fake-session',
    uuid: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    ...extra,
  }
}

export const fakeAssistant = (text: string, parent: string | null = null) =>
  fakeMessage('assistant', { parent_tool_use_id: parent, message: { content: [{ type: 'text', text }] } })

export const fakeResult = (isError = false) =>
  fakeMessage('result', {
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    result: 'done',
    errors: [],
    total_cost_usd: 0,
    duration_ms: 1,
    num_turns: 1,
  })

export const fakeBackground = (...taskIds: string[]) =>
  fakeMessage('system', {
    subtype: 'background_tasks_changed',
    tasks: taskIds.map((id) => ({ task_id: id, task_type: 'local_agent', description: id })),
  })

/** Claude Code's report on a user message it queued, took into a turn, finished or dropped. */
const lifecycle = (uuid: string, state: 'queued' | 'started' | 'completed' | 'cancelled') =>
  fakeMessage('command_lifecycle', { command_uuid: uuid, state })

/** One turn of a fake session, started by the user messages waiting when it began. */
interface FakeTurn {
  text: string
  /** Aborts when the turn is interrupted or its session ends. */
  signal: AbortSignal
  session: FakeSession
  /**
   * Folds messages queued since the turn began into it, as Claude Code does between tool rounds;
   * those sent with priority 'later' wait for the next turn.
   */
  fold: () => string[]
}

/** Yields the messages of one turn; a turn that ends without a result gets an interrupted one. */
type TurnScript = (turn: FakeTurn) => AsyncIterable<FakeMessage> | Iterable<FakeMessage>

/** How a fake session answers Query.interrupt. */
type InterruptMode = 'honour' | 'reject' | 'ignore'

/** Lets one waiter sleep until something changes. */
class Wakeup {
  private wake: (() => void) | null = null

  async wait(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve
    })
  }

  poke(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

/** Messages the fake process writes, read by the runner through the query. */
class Outbox {
  private readonly items: FakeMessage[] = []
  private readonly wakeup = new Wakeup()
  private ended = false
  private failure: Error | null = null

  push(m: FakeMessage): void {
    if (!this.ended) {
      this.items.push(m)
      this.wakeup.poke()
    }
  }

  end(failure: Error | null = null): void {
    if (!this.ended) {
      this.ended = true
      this.failure = failure
      this.wakeup.poke()
    }
  }

  async *drain(): AsyncGenerator<FakeMessage> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.ended) {
        if (this.failure !== null) {
          throw this.failure
        }
        return
      }
      await this.wakeup.wait()
    }
  }
}

const textOf = (m: SDKUserMessage) =>
  typeof m.message.content === 'string'
    ? m.message.content
    : m.message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')

/** Resolves once the signal aborts. */
export const aborted = async (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
    }
    signal.addEventListener('abort', () => {
      resolve()
    })
  })

interface QueuedInput {
  text: string
  uuid: string
  priority: SDKUserMessage['priority']
}

/**
 * One fake Claude Code process. Like the real CLI it queues messages sent during a turn, which
 * the turn folds in or the next turn takes together; a session's first turn takes only one.
 */
export class FakeSession {
  /** Every user message the process read, in order, as text and as sent. */
  readonly prompts: string[] = []
  readonly inputs: SDKUserMessage[] = []
  /** The priority each of those messages came with. */
  readonly priorities: SDKUserMessage['priority'][] = []
  readonly stoppedTasks: string[] = []
  /** Settings Seti handed the running process, as Query.applyFlagSettings got them. */
  readonly flagSettings: Record<string, unknown>[] = []
  /** Modes Seti switched the running process to; like Claude Code, bypass needs the start flag. */
  readonly modes: string[] = []
  closed = false
  /** Text of the running turn's user messages. */
  current: string | null = null
  private readonly outbox = new Outbox()
  private readonly queue: QueuedInput[] = []
  private inputDone = false
  private readonly wakeup = new Wakeup()
  private turns = 0
  private turn: AbortController | null = null
  private consumed: string[] = []
  readonly options: Options
  private readonly sdk: FakeSdk

  constructor(options: Options, sdk: FakeSdk) {
    this.options = options
    this.sdk = sdk
    options.abortController?.signal.addEventListener('abort', () => {
      this.close()
    })
  }

  /** Writes a message the process sends on its own, such as background work reporting back. */
  emit(m: FakeMessage): void {
    this.outbox.push(m)
  }

  async run(input: AsyncIterable<SDKUserMessage>, script: TurnScript): Promise<void> {
    void this.read(input)
    for (;;) {
      const batch = await this.nextBatch()
      if (batch.length === 0) {
        break
      }
      await this.runTurn(batch, script)
    }
    this.outbox.end()
  }

  messages(): AsyncGenerator<FakeMessage> {
    return this.outbox.drain()
  }

  async interrupt(): Promise<{ still_queued: string[] }> {
    this.sdk.interrupted.push(this.current ?? '')
    if (this.sdk.interruptMode === 'reject') {
      throw new Error('interrupt is not available')
    }
    if (this.sdk.interruptMode === 'honour') {
      this.turn?.abort()
    }
    return Promise.resolve({ still_queued: this.queue.map((queued) => queued.uuid) })
  }

  /** Drops a message that is still queued; false once a turn took it. */
  async cancelAsyncMessage(uuid: string): Promise<boolean> {
    const index = this.queue.findIndex((queued) => queued.uuid === uuid)
    if (index < 0) {
      return Promise.resolve(false)
    }
    this.queue.splice(index, 1)
    this.outbox.push(lifecycle(uuid, 'cancelled'))
    return Promise.resolve(true)
  }

  async stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId)
    this.sdk.onStopTask(this, taskId)
    return Promise.resolve()
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.current !== null) {
      this.sdk.aborted.push(this.current)
    }
    this.turn?.abort()
    this.wakeup.poke()
    this.outbox.end(new Error('Claude Code process aborted by user'))
  }

  private async read(input: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const m of input) {
      if (this.closed) {
        break
      }
      const uuid = m.uuid ?? ''
      this.prompts.push(textOf(m))
      this.inputs.push(m)
      this.priorities.push(m.priority)
      this.queue.push({ text: textOf(m), uuid, priority: m.priority })
      this.outbox.push(lifecycle(uuid, 'queued'))
      this.wakeup.poke()
    }
    this.inputDone = true
    this.wakeup.poke()
  }

  private async nextBatch(): Promise<QueuedInput[]> {
    while (!this.closed) {
      if (this.queue.length > 0) {
        return this.queue.splice(0, this.turns === 0 ? 1 : this.queue.length)
      }
      if (this.inputDone) {
        break
      }
      await this.wakeup.wait()
    }
    return []
  }

  private take(batch: readonly QueuedInput[]): string[] {
    for (const queued of batch) {
      this.consumed.push(queued.uuid)
      this.outbox.push(lifecycle(queued.uuid, 'started'))
    }
    return batch.map((queued) => queued.text)
  }

  private async runTurn(batch: readonly QueuedInput[], script: TurnScript): Promise<void> {
    this.turns += 1
    this.consumed = []
    const text = this.take(batch).join('\n\n')
    const turn = new AbortController()
    this.turn = turn
    this.current = text
    const fold = () => {
      const now = this.queue.filter((queued) => queued.priority !== 'later')
      this.queue.splice(0, this.queue.length, ...this.queue.filter((queued) => queued.priority === 'later'))
      return this.take(now)
    }
    let ended = false
    try {
      for await (const m of script({ text, signal: turn.signal, session: this, fold })) {
        ended ||= m.type === 'result'
        this.outbox.push(m.type === 'result' ? { ...m, user_message_uuids: this.consumed } : m)
      }
      if (!ended) {
        this.outbox.push(fakeMessage('user', { message: { role: 'user', content: '[Request interrupted by user]' } }))
        this.outbox.push({ ...fakeResult(true), user_message_uuids: this.consumed })
      }
      for (const uuid of this.consumed) {
        this.outbox.push(lifecycle(uuid, 'completed'))
      }
    } catch (e) {
      this.outbox.end(e instanceof Error ? e : new Error(String(e)))
    } finally {
      this.turn = null
      this.current = null
    }
  }
}

/** A stand-in for the Agent SDK's streaming `query`, one FakeSession per call. */
export class FakeSdk {
  readonly sessions: FakeSession[] = []
  /** Texts of the turns running when Query.interrupt came, and of those a closed session cut. */
  readonly interrupted: string[] = []
  readonly aborted: string[] = []
  interruptMode: InterruptMode = 'honour'
  /** Whether queries offer cancelAsyncMessage, which the SDK's Query type does not declare. */
  cancels = true
  onStopTask: (session: FakeSession, taskId: string) => void = () => undefined
  /** What every session answers when asked how its MCP servers connected. */
  mcpStatus: McpServerStatus[] = []

  private readonly script: TurnScript

  constructor(script: TurnScript) {
    this.script = script
  }

  /** Every user message any session received, in order. */
  get prompts(): string[] {
    return this.sessions.flatMap((session) => session.prompts)
  }

  /** The newest session. */
  get last(): FakeSession | undefined {
    return this.sessions.at(-1)
  }

  readonly query = ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    if (typeof prompt === 'string') {
      throw new Error('Seti streams its prompts')
    }
    const session = new FakeSession(options ?? {}, this)
    this.sessions.push(session)
    void session.run(prompt, this.script)
    const controls = {
      interrupt: async () => session.interrupt(),
      stopTask: async (taskId: string) => session.stopTask(taskId),
      close: () => {
        session.close()
      },
      mcpServerStatus: async () => Promise.resolve(this.mcpStatus),
      applyFlagSettings: async (settings: Record<string, unknown>) => {
        session.flagSettings.push(settings)
        return Promise.resolve()
      },
      setPermissionMode: async (mode: string) => {
        if (mode === 'bypassPermissions' && options?.allowDangerouslySkipPermissions !== true) {
          throw new Error('Cannot set permission mode to bypassPermissions')
        }
        session.modes.push(mode)
        return Promise.resolve()
      },
    }
    const cancel = { cancelAsyncMessage: async (uuid: string) => session.cancelAsyncMessage(uuid) }
    return Object.assign(session.messages() as AsyncGenerator<SDKMessage>, controls, this.cancels ? cancel : {})
  }
}
