import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promptUsage, type AcpRecord } from '@seti/shared'
import { z } from 'zod'
import type { Launcher } from '../../launcher.js'
import type { InputContent, RuntimeSession, SessionInput, SessionReport } from '../adapter.js'
import { JsonRpc, RpcError, type RpcCall } from '../json-rpc.js'
import { ReportQueue } from '../report-queue.js'
import { Permissions, type AcpDecide } from './permissions.js'
import { acpReport, UpdateJoiner } from './records.js'

/** An ACP runtime's shapes: a neutral decision, a JSON-RPC process, no hooks, rules or modes. */
export interface AcpShapes {
  vendor: null
  realised: AcpRealised
  decide: AcpDecide
  hooks: null
  hostServers: Record<string, never>
  policy: never
  mode: never
}

type Spawn = NonNullable<Launcher['spawn']>

/** What an ACP session starts from: the agent to launch, its session and who answers its asks. */
export interface AcpRealised {
  /** The agent's name in errors, such as "Gemini CLI". */
  label: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  resume: string | null
  model: string
  /** The tool servers `session/new` and `session/load` hand the agent, as ACP describes them. */
  mcpServers: readonly unknown[]
  spawn: Spawn
  decide: AcpDecide
  signal: AbortSignal
}

const PROTOCOL = 1

const initialized = z.looseObject({ protocolVersion: z.number() })
const sessionReply = z.looseObject({ sessionId: z.string() })
const promptReply = z.looseObject({ stopReason: z.string(), usage: promptUsage.nullish() })
const updateNote = z.looseObject({ sessionId: z.string(), update: z.unknown() })
const callNote = z.looseObject({ toolCallId: z.string(), status: z.string().optional() })

function promptOf(content: InputContent): unknown[] {
  const images = content.images.map((image) => ({ type: 'image', mimeType: image.mime, data: image.data }))
  return [{ type: 'text', text: content.text }, ...images]
}

/** How long the agent may pause mid-message before Seti stores what it said so far. */
const QUIET_MS = 500

const UNREADABLE = { v: 1, thread: '', type: 'vendor', name: 'acp', unreadable: true } as const

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Drives one ACP agent process over its stdio: one prompt per input, in order. */
class Driver {
  readonly reports = new ReportQueue()
  private session = ''
  private turn: string | null = null
  private closing = false
  /** Updates the agent replays while it loads a session, which Seti stored the first time. */
  private loading = false
  /** A loaded session's start, held until its first turn: opening the session is not work. */
  private resumed: AcpRecord | null = null
  private sending: Promise<void> = Promise.resolve()
  private readonly joiner = new UpdateJoiner()
  private quiet: NodeJS.Timeout | null = null
  /** Calls of the running turn that have not ended, by id. */
  private readonly open = new Set<string>()
  private readonly refused = new Set<string>()
  /** Calls a cancel cut: the agent may still end them as completed, which Seti does not store. */
  private cut = new Set<string>()
  private readonly permissions: Permissions
  private readonly rpc: JsonRpc
  private readonly realised: AcpRealised
  private readonly child: ChildProcess

  constructor(child: ChildProcess, realised: AcpRealised) {
    this.child = child
    this.realised = realised
    this.rpc = new JsonRpc(child, { stamped: true })
    this.permissions = new Permissions({
      rpc: this.rpc,
      decide: realised.decide,
      refused: (callId) => this.refused.add(callId),
    })
  }

  /** Reads the agent's output, opens the session, then takes inputs; reports go to `reports`. */
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
          this.notified(message)
        },
        asked: (message) => {
          this.asked(message)
        },
        garbled: () => {
          this.store(this.joiner.flush())
          this.reports.push({
            type: 'message',
            raw: null,
            events: [UNREADABLE],
            work: false,
            byAgent: false,
            delivered: [],
          })
        },
      })
      .then(async () => {
        this.ended(await exited)
      })
    try {
      await this.start()
    } catch (e) {
      this.reports.fail(new Error(`${this.realised.label} did not open its session: ${errorText(e)}`))
    }
    void this.pump(inputs)
    yield* this.reports
  }

  /** Cancels the running turn; the agent ends its prompt with `cancelled`. */
  async interrupt(): Promise<void> {
    if (this.turn === null) {
      return
    }
    this.cut = new Set(this.open)
    this.rpc.notify('session/cancel', { sessionId: this.session })
    this.permissions.cancel()
    await Promise.resolve()
  }

  close(): void {
    if (this.closing) {
      return
    }
    this.closing = true
    this.permissions.dropAll()
    this.rpc.end(new Error(`The ${this.realised.label} session was closed`))
    this.reports.end()
    this.child.kill()
  }

  private async start(): Promise<void> {
    const init = initialized.parse(
      await this.rpc.request('initialize', {
        protocolVersion: PROTOCOL,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
    )
    if (init.protocolVersion !== PROTOCOL) {
      throw new Error(`it speaks ACP version ${String(init.protocolVersion)}, Seti speaks ${String(PROTOCOL)}`)
    }
    const { resume, cwd, model, mcpServers } = this.realised
    if (resume === null) {
      this.session = sessionReply.parse(await this.rpc.request('session/new', { cwd, mcpServers })).sessionId
      this.reports.push(acpReport({ seti: 'started', sessionId: this.session, model, cwd }))
      return
    }
    this.loading = true
    await this.rpc.request('session/load', { sessionId: resume, cwd, mcpServers })
    this.loading = false
    this.session = resume
    this.resumed = { seti: 'started', sessionId: resume, model, cwd }
  }

  private async pump(inputs: AsyncIterable<SessionInput>): Promise<void> {
    for await (const input of inputs) {
      if (this.closing) {
        return
      }
      if (this.turn !== null) {
        this.reports.push({ type: 'input', id: input.id, state: 'queued' })
      }
      this.sending = this.sending.then(async () => this.prompt(input))
    }
  }

  /** Runs one input as a turn of its own and stores its end. */
  private async prompt(input: SessionInput): Promise<void> {
    if (this.closing) {
      return
    }
    const turnId = randomUUID()
    this.turn = turnId
    this.permissions.resume()
    if (this.resumed !== null) {
      this.reports.push(acpReport(this.resumed))
      this.resumed = null
    }
    this.reports.push(acpReport({ seti: 'turn', turnId }))
    this.reports.push({ type: 'input', id: input.id, state: 'started' })
    let ended: AcpRecord
    try {
      const reply = await this.rpc.request('session/prompt', {
        sessionId: this.session,
        prompt: promptOf(input.content),
      })
      const { stopReason, usage } = promptReply.parse(reply)
      ended = { seti: 'ended', turnId, stopReason, result: '', usage: usage ?? null }
    } catch (e) {
      if (!(e instanceof RpcError) && !(e instanceof z.ZodError)) {
        return
      }
      ended = { seti: 'ended', turnId, stopReason: 'error', result: '', usage: null, error: errorText(e) }
    }
    this.finish(ended, input.id)
  }

  private finish(ended: Extract<AcpRecord, { seti: 'ended' }>, inputId: string): void {
    this.store(this.joiner.flush())
    const unfinished = [...this.open]
    this.open.clear()
    this.refused.clear()
    this.cut.clear()
    this.turn = null
    const record = { ...ended, result: this.joiner.result(), ...(unfinished.length === 0 ? {} : { unfinished }) }
    this.reports.push(acpReport(record, [inputId]))
  }

  private notified(message: RpcCall): void {
    if (message.method !== 'session/update' || this.loading) {
      return
    }
    const note = updateNote.safeParse(message.params)
    if (!note.success || note.data.sessionId !== this.session) {
      return
    }
    if (this.wasCut(note.data.update)) {
      return
    }
    const denied = this.track(note.data.update)
    this.store(this.joiner.take(note.data.update, denied))
    this.hush()
  }

  private store(records: readonly AcpRecord[]): void {
    for (const record of records) {
      this.reports.push(acpReport(record))
    }
  }

  /** Stores held chunks once the agent has been quiet a moment, so a pause shows what it said. */
  private hush(): void {
    if (this.quiet !== null) {
      clearTimeout(this.quiet)
    }
    this.quiet = setTimeout(() => {
      this.quiet = null
      this.store(this.joiner.flush())
    }, QUIET_MS)
  }

  /** The update reports a call the cancel cut, which the turn's end lists as unfinished. */
  private wasCut(update: unknown): boolean {
    const call = callNote.safeParse(update)
    return call.success && this.cut.has(call.data.toolCallId)
  }

  /** Follows the turn's open calls; true where the update ends a call Seti refused. */
  private track(update: unknown): boolean {
    const call = callNote.safeParse(update)
    if (!call.success) {
      return false
    }
    const { toolCallId, status } = call.data
    if (status === 'completed' || status === 'failed') {
      this.open.delete(toolCallId)
      return status === 'failed' && this.refused.has(toolCallId)
    }
    this.open.add(toolCallId)
    return false
  }

  private asked(message: RpcCall & { id: number | string }): void {
    if (message.method === 'session/request_permission') {
      this.permissions.take(message.id, message.params)
      return
    }
    this.rpc.refuse(message.id, `Seti does not answer ${message.method}`)
  }

  private ended([code, signal]: [number | null, NodeJS.Signals | null]): void {
    this.permissions.dropAll()
    if (this.closing) {
      return
    }
    const error = new Error(`${this.realised.label} exited with ${String(code ?? signal)}: ${this.rpc.stderrTail}`)
    this.rpc.end(error)
    this.reports.fail(error)
  }
}

/** Starts an ACP agent through the launcher and opens or loads its session. */
export function acpSession(realised: AcpRealised, inputs: AsyncIterable<SessionInput>): RuntimeSession<AcpShapes> {
  const { command, args, cwd, env, signal } = realised
  const driver = new Driver(realised.spawn({ command, args, cwd, env, signal }), realised)
  signal.addEventListener('abort', () => {
    driver.close()
  })
  return {
    events: driver.events(inputs),
    interrupt: async () => driver.interrupt(),
    close: () => {
      driver.close()
    },
  }
}
