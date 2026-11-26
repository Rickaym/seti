import type { ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { z } from 'zod'

const id = z.union([z.number(), z.string()])

const request = z.looseObject({ id, method: z.string(), params: z.unknown().optional() })
const reply = z.looseObject({
  id,
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number().optional(), message: z.string() }).optional(),
})
const notification = z.looseObject({ method: z.string(), params: z.unknown().optional() })

/** A notification or request as the runtime sent it. */
export interface RpcCall {
  method: string
  params?: unknown
}

/** What a driver hands its session as lines arrive. */
export interface RpcHandlers {
  notified: (message: RpcCall) => void
  /** The runtime asks Seti and waits for the answer: a result, or a JSON-RPC error. */
  asked: (message: RpcCall & { id: number | string }) => void
  /** A line that is not a JSON-RPC message at all. */
  garbled: (line: string) => void
}

/** An error the runtime answered a request with. */
export class RpcError extends Error {
  readonly code: number | undefined

  constructor(message: string, code: number | undefined) {
    super(message)
    this.code = code
  }
}

const STDERR_TAIL = 2000

/**
 * JSON-RPC over a runtime's stdio, one JSON object per line; `stamped` writes the `jsonrpc`
 * field, which Codex leaves out and ACP needs. It never times out a request: a reply may wait as
 * long as the user takes.
 */
export class JsonRpc {
  private next = 1
  private over: Error | null = null
  private stderr = ''
  private lines: Interface | null = null
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (e: Error) => void }>()
  private readonly child: ChildProcess
  private readonly stamp: { jsonrpc: '2.0' } | Record<string, never>

  constructor(child: ChildProcess, options: { stamped: boolean } = { stamped: false }) {
    this.child = child
    this.stamp = options.stamped ? { jsonrpc: '2.0' } : {}
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-STDERR_TAIL)
    })
  }

  /** The last lines the runtime wrote to stderr, for an error that names why it stopped. */
  get stderrTail(): string {
    return this.stderr.trim()
  }

  /** Reads lines until the process closes its output, handing each to the handlers. */
  async read(handlers: RpcHandlers): Promise<void> {
    if (this.child.stdout === null) {
      return
    }
    this.lines = createInterface({ input: this.child.stdout })
    for await (const line of this.lines) {
      this.take(line, handlers)
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.over !== null) {
      throw this.over
    }
    const sent = this.next
    this.next += 1
    const answered = new Promise<unknown>((resolve, reject) => {
      this.pending.set(sent, { resolve, reject })
    })
    this.write({ id: sent, method, params })
    return answered
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  answer(to: number | string, result: unknown): void {
    this.write({ id: to, result })
  }

  refuse(to: number | string, message: string): void {
    this.write({ id: to, error: { code: -32601, message } })
  }

  /** Fails every request still waiting, and every later one, with this error. */
  end(error: Error): void {
    this.over ??= error
    for (const waiting of this.pending.values()) {
      waiting.reject(this.over)
    }
    this.pending.clear()
    this.lines?.close()
  }

  private write(message: Record<string, unknown>): void {
    if (this.over === null && this.child.stdin?.writable === true) {
      this.child.stdin.write(`${JSON.stringify({ ...this.stamp, ...message })}\n`)
    }
  }

  private take(line: string, handlers: RpcHandlers): void {
    if (line.trim() === '') {
      return
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      handlers.garbled(line)
      return
    }
    const asked = request.safeParse(value)
    if (asked.success) {
      handlers.asked(asked.data)
      return
    }
    const notified = notification.safeParse(value)
    if (notified.success) {
      handlers.notified(notified.data)
      return
    }
    const replied = reply.safeParse(value)
    if (replied.success) {
      this.settle(replied.data)
      return
    }
    handlers.garbled(line)
  }

  private settle(answer: z.infer<typeof reply>): void {
    const waiting = typeof answer.id === 'number' ? this.pending.get(answer.id) : undefined
    if (waiting === undefined || typeof answer.id !== 'number') {
      return
    }
    this.pending.delete(answer.id)
    if (answer.error === undefined) {
      waiting.resolve(answer.result)
    } else {
      waiting.reject(new RpcError(answer.error.message, answer.error.code))
    }
  }
}
