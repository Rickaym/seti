import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { ToolCall } from '@seti/shared'
import type { Launcher } from '../../launcher.js'
import type { RuntimeSession, SessionInput } from '../adapter.js'
import { controlLine, type ControlLine, type ScriptedCommand, type Verdict } from './dialect.js'
import { scriptedToolCall } from './tools.js'

/** How Seti decides a call the scripted runtime asks about, until the signal aborts. */
type ScriptedDecide = (call: ToolCall, signal: AbortSignal) => Promise<Verdict>

/** The scripted runtime's own shapes: a neutral decision, JSON lines, and no hooks or modes. */
export interface ScriptedShapes {
  vendor: unknown
  realised: ScriptedRealised
  decide: ScriptedDecide
  hooks: null
  hostServers: Record<string, never>
  message: unknown
  toolServer: never
  policy: never
  mode: never
}

type Spawn = NonNullable<Launcher['spawn']>

/** What a scripted session starts from: the process to launch and how its asks are answered. */
interface ScriptedRealised {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  resume: string | null
  spawn: Spawn
  decide: ScriptedDecide
  signal: AbortSignal
}

const STDERR_TAIL = 2000

/** A line as the runtime wrote it: its JSON value, or the text when it is not JSON. */
const parsed = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return line
  }
}

/** Drives one process of the scripted runtime over its stdio, one JSON object per line. */
class Driver {
  private closing = false
  private over = false
  private rid = 0
  private stderr = ''
  private readonly acks = new Map<number, { resolve: () => void; reject: (e: Error) => void }>()
  private readonly asks = new AbortController()
  private readonly exited: Promise<unknown[]>
  private readonly child: ChildProcess
  private readonly decide: ScriptedDecide

  constructor(child: ChildProcess, decide: ScriptedDecide, exited: Promise<unknown[]>) {
    this.child = child
    this.decide = decide
    this.exited = exited
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-STDERR_TAIL)
    })
  }

  write(command: ScriptedCommand): void {
    if (!this.closing && this.child.stdin?.writable === true) {
      this.child.stdin.write(`${JSON.stringify(command)}\n`)
    }
  }

  async *messages(): AsyncGenerator {
    if (this.child.stdout !== null) {
      for await (const line of createInterface({ input: this.child.stdout })) {
        const message = parsed(line)
        const control = controlLine.safeParse(message)
        if (control.success) {
          this.control(control.data)
        } else {
          yield message
        }
      }
    }
    const [code, signal] = await this.exited
    this.ended()
    if (!this.closing && code !== 0) {
      throw new Error(`The scripted runtime exited with ${String(code ?? signal)}: ${this.stderr.trim()}`)
    }
  }

  async interrupt(): Promise<void> {
    if (this.over) {
      throw new Error('The scripted runtime has ended')
    }
    this.rid += 1
    const rid = this.rid
    const acked = new Promise<void>((resolve, reject) => {
      this.acks.set(rid, { resolve, reject })
    })
    this.write({ t: 'interrupt', rid })
    return acked
  }

  close(): void {
    this.closing = true
    this.ended()
    this.child.kill()
  }

  async pump(inputs: AsyncIterable<SessionInput>): Promise<void> {
    for await (const input of inputs) {
      this.write({ t: 'input', id: input.id, text: input.content.text })
    }
  }

  private control(line: ControlLine): void {
    if (line.t === 'ack') {
      const waiting = this.acks.get(line.rid)
      this.acks.delete(line.rid)
      if (line.ok) {
        waiting?.resolve()
      } else {
        waiting?.reject(new Error(line.error ?? 'The scripted runtime refused the command'))
      }
      return
    }
    void this.decide(scriptedToolCall(line.call), this.asks.signal).then(
      (verdict) => {
        this.write({ t: 'verdict', rid: line.rid, verdict })
      },
      (e: unknown) => {
        this.write({ t: 'verdict', rid: line.rid, verdict: { allow: false, message: String(e) } })
      },
    )
  }

  /** Settles what waits on the process once it ended or Seti closed it. */
  private ended(): void {
    this.over = true
    this.asks.abort()
    for (const waiting of this.acks.values()) {
      waiting.reject(new Error('The scripted runtime ended before it answered'))
    }
    this.acks.clear()
  }
}

/** Starts a process of the scripted runtime through the launcher and opens or resumes its session. */
export function scriptedSession(
  realised: ScriptedRealised,
  inputs: AsyncIterable<SessionInput>,
): RuntimeSession<ScriptedShapes> {
  const child = realised.spawn({
    command: realised.command,
    args: realised.args,
    cwd: realised.cwd,
    env: realised.env,
    signal: realised.signal,
  })
  const driver = new Driver(child, realised.decide, once(child, 'exit'))
  driver.write({ t: 'open', resume: realised.resume, cwd: realised.cwd })
  void driver.pump(inputs)
  realised.signal.addEventListener('abort', () => {
    driver.close()
  })
  return {
    events: driver.messages(),
    interrupt: async () => driver.interrupt(),
    close: () => {
      driver.close()
    },
  }
}
