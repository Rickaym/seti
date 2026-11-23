import { randomUUID } from 'node:crypto'
import {
  NODE_PROTOCOL,
  nodeFrame,
  type AskFrame,
  type ControlFrame,
  type HelloFrame,
  type JournalEntry,
  type NodeCommandType,
  type NodeFrame,
} from '@seti/shared'
import { WebSocket, type RawData } from 'ws'
import { readFrame } from './node/wire.js'
import { AskLedger, JournalInbox } from './node-inbox.js'
import type { NodeCursor } from './store/node-cursors.js'

const FIRST_RETRY_MS = 1000
const LAST_RETRY_MS = 30_000
const PING_MS = 15_000

/** What the control plane does with what its node sends. */
export interface NodeClientEnd {
  /** The socket to connect to; refuses one another user could have made or reach. */
  socket: string
  check: (socket: string) => void
  journal: (agent: string, entry: JournalEntry) => Promise<void>
  answer: (frame: AskFrame, signal: AbortSignal) => Promise<unknown>
  cursors: { list: () => Promise<NodeCursor[]>; save: (cursor: NodeCursor) => Promise<void> }
  /** A node process started anew; the work it returns runs once the node is taken. */
  fresh: () => Promise<() => void>
  /** The node is stopping: records the turns it is about to cut. */
  stopping: () => Promise<void>
}

interface Pending {
  resolve: (answer: unknown) => void
  reject: (error: Error) => void
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The control plane's side of the node socket. It connects, takes the node's hello, applies each
 * journal entry once from the cursors it kept, answers asks and sends commands; a dropped link is
 * retried with a growing wait.
 */
export class NodeClient {
  private socket: WebSocket | null = null
  private welcomed = false
  private closed = false
  private retryMs = FIRST_RETRY_MS
  private readonly pending = new Map<string, Pending>()
  private readonly inbox: JournalInbox
  private readonly ledger: AskLedger
  private readonly end: NodeClientEnd

  constructor(end: NodeClientEnd) {
    this.end = end
    this.inbox = new JournalInbox(
      end.journal,
      (frame) => {
        this.send(frame)
      },
      end.cursors.save,
    )
    this.ledger = new AskLedger(end.answer)
  }

  async start(): Promise<void> {
    this.inbox.restore(await this.end.cursors.list())
    this.connect()
  }

  /** Stops connecting; commands waiting for an answer fail. */
  close(): void {
    this.closed = true
    this.socket?.terminate()
  }

  /** Sends a command to the node and waits for its answer, unchecked. */
  async command(type: NodeCommandType, body: unknown): Promise<unknown> {
    if (!this.welcomed) {
      throw new Error('The node is not connected; Seti retries the link.')
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ type: 'command', id, command: type, body })
    })
  }

  private connect(): void {
    if (this.closed) {
      return
    }
    try {
      this.end.check(this.end.socket)
    } catch (e) {
      process.stderr.write(`node link: ${errorText(e)}\n`)
      this.retry()
      return
    }
    const socket = new WebSocket(`ws+unix://${this.end.socket}:/`)
    this.socket = socket
    let alive = true
    const ping = setInterval(() => {
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      socket.ping()
    }, PING_MS)
    ping.unref()
    socket.on('pong', () => {
      alive = true
    })
    socket.on('message', (data: RawData) => {
      void this.receive(socket, data)
    })
    socket.on('error', (e) => {
      process.stderr.write(`node link: ${e.message}\n`)
    })
    socket.on('close', () => {
      clearInterval(ping)
      this.dropped(socket)
    })
  }

  private dropped(socket: WebSocket): void {
    if (this.socket !== socket) {
      return
    }
    this.socket = null
    this.welcomed = false
    for (const { reject } of this.pending.values()) {
      reject(new Error('The link to the node dropped before it answered'))
    }
    this.pending.clear()
    this.retry()
  }

  private retry(): void {
    if (this.closed) {
      return
    }
    setTimeout(() => {
      this.connect()
    }, this.retryMs).unref()
    this.retryMs = Math.min(this.retryMs * 2, LAST_RETRY_MS)
  }

  private send(frame: ControlFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame))
    }
  }

  private async receive(socket: WebSocket, data: RawData): Promise<void> {
    if (socket !== this.socket) {
      return
    }
    const parsed = nodeFrame.safeParse(readFrame(data))
    if (!parsed.success) {
      process.stderr.write('node link: a frame the node sent does not fit the protocol\n')
      return
    }
    try {
      await this.take(parsed.data)
    } catch (e) {
      process.stderr.write(`node link: ${parsed.data.type}: ${errorText(e)}\n`)
    }
  }

  private async take(frame: NodeFrame): Promise<void> {
    switch (frame.type) {
      case 'hello':
        await this.hello(frame)
        return
      case 'journal.append':
        this.inbox.receive(frame)
        return
      case 'ask':
        this.send(await this.ledger.receive(frame))
        return
      case 'ask.cancel':
        this.ledger.cancel(frame)
        return
      case 'command.answer':
      case 'command.error':
        this.answered(frame)
        return
      case 'node.stopping':
        await this.end.stopping().finally(() => {
          this.send({ type: 'node.stop' })
        })
    }
  }

  private answered(frame: Extract<NodeFrame, { type: 'command.answer' | 'command.error' }>): void {
    const pending = this.pending.get(frame.id)
    this.pending.delete(frame.id)
    if (frame.type === 'command.answer') {
      pending?.resolve(frame.answer)
    } else {
      pending?.reject(new Error(frame.error))
    }
  }

  /** Takes the node: a new node process first settles the turns the old one lost. */
  private async hello(frame: HelloFrame): Promise<void> {
    if (frame.protocol !== NODE_PROTOCOL) {
      this.send({ type: 'refused', reason: `Protocol ${String(NODE_PROTOCOL)} only` })
      this.socket?.close(1000, 'Protocol')
      return
    }
    const after = frame.fresh ? await this.end.fresh() : null
    for (const { agent, state, since } of frame.sessions) {
      await this.end.journal(agent, state)
      if (since !== null) {
        await this.end.journal(agent, { type: 'session.since', promptId: since })
      }
    }
    for (const position of frame.journals) {
      this.inbox.hello(position)
    }
    const cursors = [...this.inbox.positions()].map(([agent, { epoch, seq }]) => ({ agent, epoch, seq }))
    this.send({ type: 'welcome', protocol: NODE_PROTOCOL, cursors })
    this.welcomed = true
    this.retryMs = FIRST_RETRY_MS
    after?.()
  }
}
