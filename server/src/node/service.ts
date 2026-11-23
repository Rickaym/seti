import { randomUUID } from 'node:crypto'
import {
  controlFrame,
  NODE_PROTOCOL,
  type ControlFrame,
  type HelloFrame,
  type NodeCommandType,
  type NodeFrame,
} from '@seti/shared'
import type { RawData, WebSocket } from 'ws'
import type { RemoteControl } from '../node-link.js'
import { AskOutbox, JournalOutbox } from '../node-outbox.js'
import { readFrame } from './wire.js'

/** What the node service needs from the sessions it runs. */
export interface NodeSessions {
  /** Runs a command of the control plane on this node's sessions. */
  command: (type: NodeCommandType, body: unknown) => Promise<unknown>
  /** The sessions open right now, for the hello. */
  snapshot: () => HelloFrame['sessions']
  /** Cuts the agents' running turns and waits for them to end, at most `graceMs`. */
  cut: (graceMs: number) => Promise<void>
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const within = async (work: Promise<unknown>, ms: number) =>
  Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms).unref())])

/**
 * The node's side of the socket: one control plane at a time. Entries and asks wait while no
 * control plane is connected, and go out again from where the next one stands.
 */
export class NodeService {
  readonly boot = randomUUID()
  private fresh = true
  private socket: WebSocket | null = null
  private welcomed = false
  private stopRecorded: (() => void) | null = null
  private readonly journal: JournalOutbox
  private readonly asks: AskOutbox
  private readonly sessions: NodeSessions
  private readonly build: string

  /** The control plane as this node's sessions reach it. */
  readonly control: RemoteControl = {
    journal: async (taskId, entry) => {
      this.journal.append(taskId, entry)
      return Promise.resolve()
    },
    ask: async (taskId, type, ask, signal) => this.asks.ask(taskId, type, ask, signal),
  }

  constructor(sessions: NodeSessions, build: string) {
    this.sessions = sessions
    this.build = build
    this.journal = new JournalOutbox((frame) => {
      this.send(frame)
    })
    this.journal.disconnected()
    this.asks = new AskOutbox((frame) => {
      this.send(frame)
    })
  }

  /** A control plane connected; it replaces the one before. */
  attach(socket: WebSocket): void {
    this.socket?.close(1000, 'Another control plane connected')
    this.detach()
    this.socket = socket
    socket.on('message', (data: RawData) => {
      this.receive(socket, data)
    })
    socket.on('close', () => {
      if (this.socket === socket) {
        this.detach()
      }
    })
    const hello: HelloFrame = {
      type: 'hello',
      protocol: NODE_PROTOCOL,
      build: this.build,
      boot: this.boot,
      fresh: this.fresh,
      journals: this.journal.positions(),
      sessions: this.sessions.snapshot(),
    }
    this.send(hello)
  }

  /**
   * Stops for a restart: the control plane records the running turns, the node cuts them and
   * waits until every entry is stored, each step for at most `graceMs`.
   */
  async stop(graceMs: number): Promise<void> {
    if (this.welcomed) {
      const recorded = new Promise<void>((resolve) => {
        this.stopRecorded = resolve
      })
      this.send({ type: 'node.stopping' })
      await within(recorded, graceMs)
    }
    await this.sessions.cut(graceMs)
    await within(this.journal.drained(), graceMs)
  }

  private detach(): void {
    this.socket = null
    this.welcomed = false
    this.journal.disconnected()
  }

  private send(frame: NodeFrame): void {
    const socket = this.socket
    if (socket !== null && socket.readyState === socket.OPEN && (this.welcomed || frame.type === 'hello')) {
      socket.send(JSON.stringify(frame))
    }
  }

  private receive(socket: WebSocket, data: RawData): void {
    if (socket !== this.socket) {
      return
    }
    const parsed = controlFrame.safeParse(readFrame(data))
    if (!parsed.success) {
      process.stderr.write(`node: a frame the control plane sent does not fit the protocol\n`)
      return
    }
    this.take(parsed.data)
  }

  private take(frame: ControlFrame): void {
    switch (frame.type) {
      case 'welcome':
        this.welcome(frame.cursors)
        return
      case 'journal.ack':
      case 'journal.reject':
        this.journal.reply(frame)
        return
      case 'ask.answer':
      case 'ask.error':
        this.asks.reply(frame)
        return
      case 'command':
        void this.run(frame.id, frame.command, frame.body)
        return
      case 'node.stop':
        this.stopRecorded?.()
        return
      case 'refused':
        process.stderr.write(`node: the control plane refused this node: ${frame.reason}\n`)
        this.socket?.close(1000, 'Refused')
    }
  }

  private welcome(cursors: { agent: string; epoch: string; seq: number }[]): void {
    this.welcomed = true
    this.fresh = false
    this.journal.resume(new Map(cursors.map(({ agent, epoch, seq }) => [agent, { epoch, seq }])))
    this.asks.resume()
  }

  private async run(id: string, type: NodeCommandType, body: unknown): Promise<void> {
    try {
      this.send({ type: 'command.answer', id, answer: await this.sessions.command(type, body) })
    } catch (e) {
      this.send({ type: 'command.error', id, error: errorText(e) })
    }
  }
}
