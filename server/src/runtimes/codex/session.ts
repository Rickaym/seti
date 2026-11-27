import type { ChildProcess } from 'node:child_process'
import type { ToolCall } from '@seti/shared'
import { z } from 'zod'
import type { CodexToolServer } from '../../codex-tool-servers.js'
import type { Launcher } from '../../launcher.js'
import type { StdioServer } from '../../tool-relay.js'
import type { UserSkill } from '../../user-skills.js'
import type { InputContent, RuntimeSession, SessionInput, SessionReport } from '../adapter.js'
import { JsonRpc, RpcError, type RpcCall } from '../json-rpc.js'
import { ReportQueue } from '../report-queue.js'
import type { CodexDecide } from './approvals.js'
import { Asks } from './asks.js'
import { Background } from './background.js'
import { OpenCalls } from './open-calls.js'
import { OPTED_OUT } from './private.js'
import { codexReport } from './reports.js'
import { ServerStatus } from './server-status.js'

/** What a Codex agent's spec carries for Codex alone: program, model, effort, skills, servers. */
interface CodexVendor {
  binary: string
  /** Null for the runtime's default model. */
  model: string | null
  effort: string | null
  /** The user's own skills, which Seti lists for the agent itself; Codex's skill list stays off. */
  skills: readonly UserSkill[]
  /** The user's MCP servers the agent starts with, without a value. */
  servers: readonly CodexToolServer[]
}

/** Codex's shapes: a neutral decision, a JSON-RPC process, stdio tool servers, no hooks or modes. */
export interface CodexShapes {
  vendor: CodexVendor
  realised: CodexRealised
  decide: CodexDecide
  hooks: null
  hostServers: Record<string, StdioServer>
  policy: never
  mode: never
}

type Spawn = NonNullable<Launcher['spawn']>

/** What a Codex session starts from: the app-server to launch and how its asks are answered. */
export interface CodexRealised {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  resume: string | null
  /** The thread stays off disk, so nothing of it can be resumed. */
  ephemeral?: true
  model: string
  effort: string | null
  /** What Seti tells the agent beside Codex's own instructions, as a Claude agent's prompt gets. */
  instructions: string
  spawn: Spawn
  decide: CodexDecide
  signal: AbortSignal
}

/** Codex asks before every command, edit and MCP call; its own sandbox is off inside Seti's. */
const APPROVAL = 'untrusted'
const SANDBOX = { type: 'externalSandbox', networkAccess: 'enabled' } as const

const threadReply = z.looseObject({ thread: z.looseObject({ id: z.string() }) })
const turnReply = z.looseObject({ turn: z.looseObject({ id: z.string() }) })
const itemNote = z.looseObject({
  item: z.looseObject({ type: z.string(), id: z.string(), clientId: z.string().nullish() }),
})
const resolvedNote = z.looseObject({ requestId: z.union([z.number(), z.string()]) })

function codexInput(content: InputContent) {
  const images = content.images.map((image) => ({ type: 'image', url: `data:${image.mime};base64,${image.data}` }))
  return [{ type: 'text', text: content.text, text_elements: [] }, ...images]
}

/** Drives one Codex app-server process over its stdio. */
class Driver {
  readonly reports = new ReportQueue()
  readonly servers: ServerStatus
  private root = ''
  private turn: string | null = null
  private starting: Promise<string> | null = null
  private closing = false
  private taken: string[] = []
  private sending: Promise<void> = Promise.resolve()
  private readonly steered = new Map<string, SessionInput>()
  private readonly calls = new Map<string, ToolCall>()
  private readonly asks: Asks
  private readonly background: Background
  private readonly openCalls = new OpenCalls(() => this.root)
  /** A resumed thread's start, held until its first turn: opening the session is not work. */
  private resumed: SessionReport | null = null
  private inbox: Promise<void> = Promise.resolve()
  private readonly rpc: JsonRpc
  private readonly realised: CodexRealised
  private readonly child: ChildProcess

  constructor(child: ChildProcess, realised: CodexRealised) {
    this.child = child
    this.realised = realised
    this.servers = new ServerStatus(realised.args)
    this.rpc = new JsonRpc(child)
    this.background = new Background(this.rpc, () => this.root)
    this.asks = new Asks({
      rpc: this.rpc,
      reports: this.reports,
      decide: realised.decide,
      root: () => this.root,
      started: (itemId) => this.calls.get(itemId),
    })
  }

  /** Reads Codex's output, opens the thread, then takes inputs; reports go to `reports`. */
  async *events(inputs: AsyncIterable<SessionInput>): AsyncGenerator<SessionReport> {
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      this.child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        resolve([code, signal])
      })
      this.child.once('error', () => {
        if (this.child.pid === undefined) {
          resolve([null, null])
        }
      })
    })
    // Closing the session aborts the spawn's signal: the exit, not this error, reports the end.
    this.child.on('error', () => undefined)
    void this.rpc
      .read({
        notified: (message) => {
          this.inOrder(async () => this.notified(message))
        },
        asked: (message) => {
          this.inOrder(() => {
            this.asks.take(message)
          })
        },
        garbled: () => {
          this.inOrder(() => {
            this.reports.push({
              type: 'message',
              raw: null,
              events: [unreadable()],
              work: false,
              byAgent: false,
              delivered: [],
            })
          })
        },
      })
      .then(async () => {
        const exit = await exited
        this.inOrder(() => {
          this.ended(exit)
        })
      })
    await this.open()
    void this.pump(inputs)
    yield* this.reports
  }

  async interrupt(): Promise<void> {
    const turnId = this.turn ?? (this.starting === null ? null : await this.starting)
    if (turnId === null) {
      return
    }
    this.background.abandon()
    await this.rpc.request('turn/interrupt', { threadId: this.root, turnId })
    // Codex cancels the turn's asks itself; Seti stops waiting on them at once.
    this.asks.dropAll()
    await this.background.stopAbandoned()
  }

  close(): void {
    if (this.closing) {
      return
    }
    this.closing = true
    this.asks.dropAll()
    this.rpc.end(new Error('The Codex session was closed'))
    this.reports.end()
    this.child.kill()
  }

  private async open(): Promise<void> {
    await this.rpc.request('initialize', {
      clientInfo: { name: 'seti', title: 'Seti', version: '1' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: OPTED_OUT },
    })
    this.rpc.notify('initialized')
    const { resume, cwd, model, instructions, ephemeral } = this.realised
    const told = instructions === '' ? {} : { developerInstructions: instructions }
    const common = { cwd, approvalPolicy: APPROVAL, model, ...told }
    if (resume === null) {
      const start = ephemeral === true ? { ...common, ephemeral } : common
      this.root = threadReply.parse(await this.rpc.request('thread/start', start)).thread.id
      return
    }
    const reply = await this.rpc.request('thread/resume', { ...common, threadId: resume, excludeTurns: true })
    this.root = threadReply.parse(reply).thread.id
    // A resumed thread is announced only in this reply, so the reply is the row that starts it.
    this.resumed = codexReport(this.root, { method: 'thread/resume', params: { threadId: resume } }, { reply })
  }

  private async pump(inputs: AsyncIterable<SessionInput>): Promise<void> {
    for await (const input of inputs) {
      if (this.closing) {
        return
      }
      await this.queue(input, false)
    }
  }

  /** Sends inputs one at a time, in the order they came; `again` for one Codex dropped. */
  private async queue(input: SessionInput, again: boolean): Promise<void> {
    const sent = this.sending.then(async () => this.send(input, again))
    this.sending = sent.catch((e: unknown) => {
      this.reports.fail(e instanceof Error ? e : new Error(String(e)))
    })
    await this.sending
  }

  private async send(input: SessionInput, again: boolean): Promise<void> {
    const turnId = this.turn ?? (this.starting === null ? null : await this.starting.catch(() => null))
    if (turnId !== null && this.turn !== null) {
      const steered = await this.steer(turnId, input, again)
      if (steered) {
        return
      }
    }
    this.start(input)
  }

  private start(input: SessionInput): void {
    const { model, effort } = this.realised
    const params = {
      threadId: this.root,
      clientUserMessageId: input.id,
      input: codexInput(input.content),
      approvalPolicy: APPROVAL,
      sandboxPolicy: SANDBOX,
      model,
      ...(effort === null ? {} : { effort }),
    }
    const started = this.rpc.request('turn/start', params).then((reply) => turnReply.parse(reply).turn.id)
    this.starting = started
    void started.then(
      (id) => {
        this.turn ??= id
        this.starting = this.starting === started ? null : this.starting
      },
      (e: unknown) => {
        this.reports.fail(e instanceof Error ? e : new Error(String(e)))
      },
    )
  }

  /** Joins a running turn; false when that turn ended before Codex took the input. */
  private async steer(turnId: string, input: SessionInput, again: boolean): Promise<boolean> {
    try {
      const params = { threadId: this.root, expectedTurnId: turnId, clientUserMessageId: input.id }
      await this.rpc.request('turn/steer', { ...params, input: codexInput(input.content) })
      this.steered.set(input.id, input)
      if (!again) {
        this.reports.push({ type: 'input', id: input.id, state: 'queued' })
      }
      return true
    } catch (e) {
      if (e instanceof RpcError) {
        return false
      }
      throw e
    }
  }

  /** Handles what Codex wrote one line at a time, in order, even where a handler waits. */
  private inOrder(handle: () => Promise<void> | void): void {
    this.inbox = this.inbox.then(handle).catch((e: unknown) => {
      this.reports.fail(e instanceof Error ? e : new Error(String(e)))
    })
  }

  private async notified(message: RpcCall): Promise<void> {
    if (OPTED_OUT.includes(message.method)) {
      return
    }
    if (message.method === 'turn/started' && this.resumed !== null) {
      this.reports.push(this.resumed)
      this.resumed = null
    }
    const job = this.background.note(message)
    this.servers.note(message)
    this.openCalls.note(message)
    if (message.method === 'turn/completed') {
      const listed = await this.background.listed().catch(() => null)
      if (listed !== null) {
        this.reports.push(codexReport(this.root, listed.message, { reply: listed.reply }))
      }
    }
    const unfinished = this.openCalls.leftBy(message, (id) => this.background.isJob(id))
    const delivered = this.track(message)
    this.reports.push(codexReport(this.root, message, { delivered, unfinished, ...(job === undefined ? {} : { job }) }))
  }

  async stopBackground(jobId: string): Promise<void> {
    await this.background.stop(jobId)
  }

  /** Follows turns, calls and inputs; returns the inputs a turn's end reports taken. */
  private track(message: RpcCall): string[] {
    if (message.method === 'thread/started' && this.root === '') {
      this.root = threadReply.safeParse(message.params).data?.thread.id ?? ''
      return []
    }
    if (message.method === 'turn/started') {
      this.turn = turnReply.safeParse(message.params).data?.turn.id ?? this.turn
      return []
    }
    if (message.method === 'turn/completed') {
      this.turn = null
      const taken = this.taken
      this.taken = []
      this.resendDropped()
      return taken
    }
    if (message.method === 'serverRequest/resolved') {
      const done = resolvedNote.safeParse(message.params).data?.requestId
      this.asks.drop(done)
      return []
    }
    this.trackItem(message)
    return []
  }

  private trackItem(message: RpcCall): void {
    const item = itemNote.safeParse(message.params).data?.item
    if (item === undefined) {
      return
    }
    if (message.method === 'item/started') {
      const [event] = codexReport(this.root, message).events
      if (event?.type === 'tool.started') {
        this.calls.set(item.id, event.call)
      }
    } else if (message.method === 'item/completed' && item.type === 'userMessage') {
      const id = item.clientId ?? null
      if (id !== null) {
        this.steered.delete(id)
        this.taken.push(id)
        this.reports.push({ type: 'input', id, state: 'started' })
      }
    }
  }

  /** Codex drops input steered into a turn that ended before taking it, as an interrupt does. */
  private resendDropped(): void {
    const dropped = [...this.steered.values()]
    this.steered.clear()
    for (const input of dropped) {
      void this.queue(input, true)
    }
  }

  private ended([code, signal]: [number | null, NodeJS.Signals | null]): void {
    this.asks.dropAll()
    if (this.closing) {
      return
    }
    const error = new Error(`Codex exited with ${String(code ?? signal)}: ${this.rpc.stderrTail}`)
    this.rpc.end(error)
    this.reports.fail(error)
  }
}

const unreadable = () => ({ v: 1, thread: '', type: 'vendor', name: 'codex', unreadable: true }) as const

/** Starts a Codex app-server through the launcher and opens or resumes its thread. */
export function codexSession(
  realised: CodexRealised,
  inputs: AsyncIterable<SessionInput>,
): RuntimeSession<CodexShapes> {
  const { command, args, cwd, env, signal } = realised
  const driver = new Driver(realised.spawn({ command, args, cwd, env, signal }), realised)
  signal.addEventListener('abort', () => {
    driver.close()
  })
  return {
    events: driver.events(inputs),
    interrupt: async () => driver.interrupt(),
    stopBackground: async (jobId) => driver.stopBackground(jobId),
    toolServers: async () => Promise.resolve(driver.servers.list()),
    close: () => {
      driver.close()
    },
  }
}
