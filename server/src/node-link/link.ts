import type { JournalCursor, NodeMessageOf } from '@seti/shared'
import type { CloseReason, LinkConnection, OutgoingMessage } from './connection.js'
import { route, type LinkEventSink, type MessageRoutes } from './events.js'
import { Exchange, type AskReply, type AskResult, type ExchangeHandlers, type Outcome } from './exchange.js'
import { JournalReceiver } from './journal-receiver.js'
import { JournalSender, type JournalSenderOptions } from './journal-sender.js'
import type { NodeJournal } from './journal.js'
import { MemoryReplyStore, type CursorStore, type ReplyStore } from './stores.js'

const DEFAULT_PING_MS = 15_000
const SILENT_PINGS = 3

export interface LinkHandlers extends ExchangeHandlers {
  /** A newer state for an agent, or for the node when `agent` is absent. */
  state?: (message: NodeMessageOf<'state'>) => void
  bulk?: (stream: number, offset: number, data: Buffer) => void
}

export interface LinkPeerOptions {
  handlers?: LinkHandlers
  commandResults?: ReplyStore<Outcome>
  askAnswers?: ReplyStore<AskReply>
  /** On the node: the journal it sends to the control plane. */
  journal?: NodeJournal
  journalOptions?: JournalSenderOptions
  /** On the control plane: where the journals it receives are stored. */
  cursors?: CursorStore
  /** Pings this often and drops a connection silent for three pings; 0 turns pings off. */
  pingMs?: number
  onEvent?: LinkEventSink
}

/** What the handshake settled for one connection. */
export interface LinkSession {
  version: number
  features: string[]
  /** On the node: how far the control plane has stored each journal, from the welcome. */
  cursors?: Record<string, JournalCursor>
}

type StateUpdate = Omit<NodeMessageOf<'state'>, 'v' | 'type' | 'id'>

/** One side of the link to one peer; it outlives connections and resumes on the next one. */
export class LinkPeer {
  private readonly exchange: Exchange
  private readonly handlers: LinkHandlers
  private readonly sender: JournalSender | null
  private readonly receiver: JournalReceiver | null
  private readonly events: LinkEventSink
  private readonly pingMs: number
  private readonly sentStates = new Map<string, StateUpdate>()
  private readonly seenStates = new Map<string, number>()
  private connection: LinkConnection | null = null
  private session: LinkSession | null = null

  constructor(options: LinkPeerOptions = {}) {
    this.handlers = options.handlers ?? {}
    this.events = options.onEvent ?? (() => undefined)
    this.pingMs = options.pingMs ?? DEFAULT_PING_MS
    this.exchange = new Exchange(this.handlers, {
      commandResults: options.commandResults ?? new MemoryReplyStore(),
      askAnswers: options.askAnswers ?? new MemoryReplyStore(),
    })
    this.sender =
      options.journal === undefined ? null : new JournalSender(options.journal, this.events, options.journalOptions)
    this.receiver = options.cursors === undefined ? null : new JournalReceiver(options.cursors, this.events)
  }

  get connected(): boolean {
    return this.connection !== null
  }

  /** The features both sides agreed on for the current connection. */
  get features(): readonly string[] {
    return this.session?.features ?? []
  }

  /** Runs the link over `connection` until it closes; a newer connection replaces an older one. */
  async attach(connection: LinkConnection, session: LinkSession): Promise<CloseReason> {
    this.connection?.close('replaced by a newer connection')
    this.connection = connection
    this.session = session
    connection.useVersion(session.version)
    const send = (message: OutgoingMessage) => {
      connection.send(message)
    }
    let lastHeard = Date.now()
    const routes = this.routes(connection)
    const tick = () => {
      this.ping(connection, lastHeard)
    }
    const timer = this.pingMs > 0 ? setInterval(tick, this.pingMs) : null
    timer?.unref()
    return new Promise<CloseReason>((resolve) => {
      connection.listen({
        message: (message) => {
          lastHeard = Date.now()
          route(routes, message)
        },
        bulk: (stream, offset, data) => {
          this.handlers.bulk?.(stream, offset, data)
        },
        unsupported: (type) => {
          this.events({ type: 'unsupported', messageType: type })
        },
        close: (reason) => {
          if (timer !== null) {
            clearInterval(timer)
          }
          this.detach(connection)
          this.events({ type: 'disconnected', reason })
          resolve(reason)
        },
      })
      this.exchange.attach(send)
      this.sender?.attach(send, session.cursors ?? {})
      for (const state of this.sentStates.values()) {
        send({ type: 'state', ...state })
      }
    })
  }

  /** Closes the current connection, if any; the peer may reconnect. */
  disconnect(reason: string): void {
    this.connection?.close(reason)
  }

  async command(message: Omit<NodeMessageOf<'command'>, 'v' | 'type'>): Promise<Outcome> {
    return this.exchange.command(message)
  }

  async ask(message: Omit<NodeMessageOf<'ask'>, 'v' | 'type'>, signal?: AbortSignal): Promise<AskResult> {
    return this.exchange.ask(message, signal)
  }

  async request(message: Omit<NodeMessageOf<'request'>, 'v' | 'type' | 'id'>): Promise<Outcome> {
    return this.exchange.request(message)
  }

  /** Sends the latest state for an agent, or the node; it is sent again on every reconnect. */
  setState(state: StateUpdate): void {
    this.sentStates.set(state.agent ?? '', state)
    this.connection?.send({ type: 'state', ...state })
  }

  /** Sends bulk bytes behind every other message; dropped when the link is down. */
  sendBulk(stream: number, offset: number, data: Buffer): void {
    this.connection?.sendBulk(stream, offset, data)
  }

  private detach(connection: LinkConnection): void {
    if (this.connection !== connection) {
      return
    }
    this.connection = null
    this.session = null
    this.exchange.detach()
    this.sender?.detach()
  }

  private ping(connection: LinkConnection, lastHeard: number): void {
    if (Date.now() - lastHeard > this.pingMs * SILENT_PINGS) {
      connection.close('no message for three pings')
      return
    }
    connection.send({ type: 'ping' })
  }

  private applyState(message: NodeMessageOf<'state'>): void {
    const key = message.agent ?? ''
    if (message.version <= (this.seenStates.get(key) ?? -1)) {
      return
    }
    this.seenStates.set(key, message.version)
    this.handlers.state?.(message)
  }

  private routes(connection: LinkConnection): MessageRoutes {
    const send = (message: OutgoingMessage) => {
      connection.send(message)
    }
    const ignore = () => undefined
    return {
      ...this.exchange.routes(),
      hello: ignore,
      welcome: ignore,
      bye: ignore,
      pong: ignore,
      ping: () => {
        send({ type: 'pong' })
      },
      state: (message) => {
        this.applyState(message)
      },
      'journal.append': (message) => {
        void this.receiver?.receive(message, send).catch(() => {
          connection.close('could not store the journal')
        })
      },
      'journal.ack': (message) => this.sender?.ack(message),
      'journal.reject': (message) => this.sender?.reject(message),
    }
  }
}
