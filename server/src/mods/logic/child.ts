import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  MOD_LIMITS,
  modChildMessage,
  type ModChildMessage,
  type ModError,
  type ModEvent,
  type ModEventContext,
} from '@seti/shared'
import { cleanText, type EventCall, type EventCounters, type ModEventRun, type OpReply } from './dispatch.js'
import { runnerFiles } from './engine-files.js'
import { isolation, sandboxCommand, treeRss, type Isolation, type SandboxEntry } from '../../script-sandbox.js'

/** One event for one mod, with everything Seti verified: the script by its hash, the grants. */
export interface ModLogicJob {
  run: ModEventRun
  version: string
  hash: string
  script: string
  event: ModEvent
  agentId?: string
  /** The engine's wall time; the pool stops the child a grace period after it. */
  wallMs: number
}

export interface ModEventUsage {
  cpuMs: number
  calls: number
}

type Ended = { ok: true; value: unknown; logs: string[] } | { ok: false; error: ModError; logs: string[] }

/** How an event ended; refused lists the calls Seti refused, for the mod's log. */
export type ModEventResult = Ended & { usage: ModEventUsage; refused: readonly string[] }

/** How a runner child starts and what it may use. */
export interface ChildOptions {
  /** Runs one call from a child's event; the pool has checked the call belongs to that event. */
  dispatch: (event: EventCall, op: string, args: unknown) => Promise<OpReply>
  startupMs?: number
  /** Resident memory of a child's whole process tree. */
  rssBytes?: number
  heapMb?: number
  isolation?: Isolation
  /** The runner a child starts; tests swap it for one that misbehaves. */
  entry?: SandboxEntry
}

/** An event Seti stopped because it is shutting down; the mod did not fail on its own account. */
export class PoolClosedError extends Error {}

export interface Job {
  request: ModLogicJob
  counters: EventCounters
  callIds: Set<number>
  queued: number
  resolve: (result: ModEventResult) => void
  reject: (error: Error) => void
}

export interface ChildEvents {
  free: () => void
  gone: (child: LogicChild) => void
}

const WATCH_MS = 50
const STARTUP_MS = 15_000
const HEAP_MB = 64
/** A call line longer than its args cap plus this is refused unread. */
const CALL_ENVELOPE = 512
const CALL_PREFIX = /^\{"type":"call","eventId":"([^"\\]{1,64})","callId":(\d{1,15}),"op":"[^"\\]{0,40}","args":/
const NEWLINE = 10

const engineLimits = (wallMs: number) => ({
  memoryBytes: MOD_LIMITS.memoryBytes,
  cpuSliceMs: MOD_LIMITS.cpuSliceMs,
  cpuTotalMs: MOD_LIMITS.cpuTotalMs,
  wallMs,
  calls: MOD_LIMITS.callsPerEvent,
  callArgsBytes: MOD_LIMITS.callArgsBytes,
  outputBytes: MOD_LIMITS.outputBytes,
  logLines: MOD_LIMITS.logLines,
  logLineChars: MOD_LIMITS.logLineChars,
})

const OUTPUT_TOO_LARGE = `The script returned over ${String(MOD_LIMITS.outputBytes / 1024)} KB`

/** An event's end as the child reported it, held to the output cap whatever the child checked. */
function endOf(
  message: Extract<ModChildMessage, { type: 'done' }>,
  clean: (text: string) => string,
  logs: string[],
): Ended {
  if (!message.ok) {
    return { ok: false, error: { code: message.error.code, message: clean(message.error.message) }, logs }
  }
  const size = Buffer.byteLength(JSON.stringify(message.value ?? null))
  return size > MOD_LIMITS.outputBytes
    ? { ok: false, error: { code: 'limit', message: OUTPUT_TOO_LARGE }, logs }
    : { ok: true, value: message.value ?? null, logs }
}

function contextOf(request: ModLogicJob): ModEventContext {
  const { run, version, agentId } = request
  const base = { eventId: run.eventId, mod: { id: run.modId, version }, caller: run.caller }
  return agentId === undefined ? base : { ...base, agentId }
}

/** One locked-down runner process and the event it runs, if any; stopped for good on any fault. */
export class LogicChild {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly options: ChildOptions
  private readonly events: ChildEvents
  private ready = false
  private retired = false
  closing = false
  private job: Job | null = null
  private owner: string | null = null
  private pending: Buffer[] = []
  private pendingBytes = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** When the running event was handed to the child. */
  private started = 0
  private readonly watch: ReturnType<typeof setInterval>

  constructor(options: ChildOptions, events: ChildEvents) {
    this.options = options
    this.events = events
    const files = runnerFiles()
    const entry = options.entry ?? { ...files.entry, args: [JSON.stringify(files.config)] }
    const use = options.isolation ?? isolation().isolation
    const { file, args } = sandboxCommand(entry, options.heapMb ?? HEAP_MB, use)
    this.child = spawn(file, args, { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.read(chunk)
    })
    this.child.stderr.resume()
    this.child.stdin.on('error', () => undefined)
    this.child.on('error', (error) => {
      this.retire(`The mod runner did not start: ${error.message}`)
    })
    this.child.on('close', (code, signal) => {
      const how = signal ?? `exit ${String(code)}`
      this.retire(`The mod runner stopped unexpectedly (${how})`)
    })
    this.setTimer(options.startupMs ?? STARTUP_MS, () => {
      this.retire(`The mod runner did not start within ${String((options.startupMs ?? STARTUP_MS) / 1000)} s`)
    })
    const rssBytes = options.rssBytes ?? MOD_LIMITS.childRssBytes
    this.watch = setInterval(() => {
      if (this.child.pid !== undefined && treeRss(this.child.pid) > rssBytes) {
        this.retire(`The mod runner used over ${String(Math.round(rssBytes / 1024 / 1024))} MB of memory`, 'limit')
      }
    }, WATCH_MS)
    this.watch.unref()
  }

  get idle(): boolean {
    return this.job === null && !this.retired
  }

  /** The one mod whose events this child runs, once it ran one; a child never serves two mods. */
  get mod(): string | null {
    return this.owner
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  start(job: Job): void {
    this.job = job
    this.owner ??= job.request.run.modId
    if (this.owner !== job.request.run.modId) {
      this.retire('A mod runner serves one mod only')
      return
    }
    if (!this.ready) {
      return
    }
    const { request } = job
    const line = JSON.stringify({
      type: 'event',
      eventId: request.run.eventId,
      hash: request.hash,
      script: request.script,
      event: request.event,
      ctx: contextOf(request),
      limits: engineLimits(request.wallMs),
    })
    if (Buffer.byteLength(line) >= MOD_LIMITS.lineBytes) {
      this.finish({ ok: false, error: { code: 'limit', message: 'The event is too large to run' }, logs: [] })
      return
    }
    this.started = Date.now()
    this.setTimer(request.wallMs + MOD_LIMITS.wallGraceMs, () => {
      this.retire(`The event ran over its ${String(request.wallMs / 1000)} s timeout and was stopped`, 'limit')
    })
    this.child.stdin.write(`${line}\n`)
  }

  retire(reason: string, code: ModError['code'] = 'failed'): void {
    if (this.retired) {
      return
    }
    this.retired = true
    this.setTimer(null)
    clearInterval(this.watch)
    this.child.kill('SIGKILL')
    const job = this.job
    this.job = null
    if (job !== null && this.closing) {
      job.reject(new PoolClosedError(reason))
    } else if (job !== null) {
      const refused = job.counters.refused
      job.resolve({ ok: false, error: { code, message: reason }, logs: [], usage: this.usageOf(job), refused })
    }
    this.events.gone(this)
  }

  private setTimer(ms: number | null, fn?: () => void): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (ms !== null && fn !== undefined) {
      this.timer = setTimeout(fn, ms)
    }
  }

  /** Splits stdout into lines; a line past the cap retires the child before it is ever parsed. */
  private read(chunk: Buffer): void {
    let rest = chunk
    for (let end = rest.indexOf(NEWLINE); end !== -1 && !this.retired; end = rest.indexOf(NEWLINE)) {
      const line = Buffer.concat([...this.pending, rest.subarray(0, end)])
      this.pending = []
      this.pendingBytes = 0
      rest = rest.subarray(end + 1)
      this.line(line)
    }
    this.pending.push(rest)
    this.pendingBytes += rest.length
    if (this.pendingBytes > MOD_LIMITS.lineBytes) {
      this.retire('The mod runner wrote a line over the size limit')
    }
  }

  private line(line: Buffer): void {
    if (line.length > MOD_LIMITS.lineBytes) {
      this.retire('The mod runner wrote a line over the size limit')
      return
    }
    if (line.length > MOD_LIMITS.callArgsBytes + CALL_ENVELOPE) {
      this.oversized(line)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line.toString('utf8'))
    } catch {
      this.retire('The mod runner wrote a line that is not JSON')
      return
    }
    const message = modChildMessage.safeParse(parsed)
    if (!message.success) {
      this.retire('The mod runner wrote a message Seti does not accept')
      return
    }
    this.receive(message.data)
  }

  /** A long line may only be an event's end; a long call is refused from its prefix, unparsed. */
  private oversized(line: Buffer): void {
    const head = line.subarray(0, 200).toString('utf8')
    const call = CALL_PREFIX.exec(head)
    if (call === null) {
      if (head.startsWith('{"type":"done"')) {
        this.parseDone(line)
        return
      }
      this.retire('The mod runner wrote a message Seti does not accept')
      return
    }
    const [, eventId = '', callId = '0'] = call
    if (this.job?.request.run.eventId !== eventId) {
      this.retire('The mod runner wrote a call for no event it runs')
      return
    }
    const limit = `A call's arguments are at most ${String(MOD_LIMITS.callArgsBytes / 1024)} KB as JSON`
    this.reply(Number(callId), { ok: false, error: { code: 'limit', message: limit } })
  }

  private parseDone(line: Buffer): void {
    try {
      const message = modChildMessage.safeParse(JSON.parse(line.toString('utf8')))
      if (message.success) {
        this.receive(message.data)
        return
      }
    } catch {
      // Falls through to retiring the child.
    }
    this.retire('The mod runner wrote a message Seti does not accept')
  }

  private receive(message: ModChildMessage): void {
    if (message.type === 'ready') {
      this.ready = true
      this.setTimer(null)
      if (this.job !== null) {
        this.start(this.job)
      }
      return
    }
    if (message.type === 'call') {
      void this.call(message.eventId, message.callId, message.op, message.args)
      return
    }
    const job = this.job
    if (job?.request.run.eventId !== message.eventId) {
      this.retire('The mod runner ended an event it was not running')
      return
    }
    const clean = (text: string) => cleanText(text, job.counters)
    const logs = message.logs.slice(0, MOD_LIMITS.logLines).map(clean)
    this.finish(endOf(message, clean, logs), message.usage.cpuMs)
    if (message.ok || message.aborted !== true) {
      this.events.free()
      return
    }
    this.retire('The engine failed on its last event')
  }

  /** Ends the event; compute is what the child reports, never more than the time it took. */
  private finish(end: Ended, cpuMs?: number): void {
    const job = this.job
    if (job === null) {
      return
    }
    this.setTimer(null)
    this.job = null
    const usage = this.usageOf(job)
    const cpu = Math.min(cpuMs ?? usage.cpuMs, usage.cpuMs)
    job.resolve({ ...end, usage: { ...usage, cpuMs: cpu }, refused: job.counters.refused })
  }

  /** A call runs only for the event this child was handed, once per call id. */
  private async call(eventId: string, callId: number, op: string, args: unknown): Promise<void> {
    const job = this.job
    if (job?.request.run.eventId !== eventId || job.callIds.has(callId)) {
      this.reply(callId, { ok: false, error: { code: 'denied', message: 'This call belongs to no running event' } })
      return
    }
    job.callIds.add(callId)
    const reply = await this.options.dispatch({ run: job.request.run, counters: job.counters }, op, args)
    if (this.job === job) {
      this.reply(callId, reply)
    }
  }

  private usageOf(job: Job): ModEventUsage {
    return { cpuMs: Date.now() - Math.max(this.started, job.queued), calls: job.counters.calls }
  }

  private reply(callId: number, reply: OpReply): void {
    const line = JSON.stringify({ type: 'reply', callId, ...reply })
    if (!this.retired) {
      this.child.stdin.write(`${line}\n`)
    }
  }
}
