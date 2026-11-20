import { randomUUID } from 'node:crypto'
import type { NodeMessageOf } from '@seti/shared'
import type { OutgoingMessage } from './connection.js'
import type { MessageRoutes } from './events.js'
import type { ReplyStore } from './stores.js'

/** The result of a command or a request: a body, or an error message. */
export type Outcome = { ok: true; body: unknown } | { ok: false; error: string }

/** How the answering side settles an ask: an answer, or a refusal to answer. */
export type AskReply = { kind: 'answer'; body: unknown } | { kind: 'cancel' }

/** What the asking side sees; `aborted` when it gave up on the ask itself. */
export type AskResult = AskReply | { kind: 'aborted' }

export interface ExchangeHandlers {
  command?: (message: NodeMessageOf<'command'>) => Promise<unknown>
  ask?: (message: NodeMessageOf<'ask'>, signal: AbortSignal) => Promise<AskReply>
  request?: (message: NodeMessageOf<'request'>) => Promise<unknown>
}

export interface ExchangeStores {
  commandResults: ReplyStore<Outcome>
  askAnswers: ReplyStore<AskReply>
}

/** A request made while the link is down, or cut off by a disconnect. */
export class OfflineError extends Error {
  override readonly name = 'OfflineError'
}

interface Pending<T> {
  message: OutgoingMessage
  reply: Promise<T>
  settle: (value: T) => void
  fail: (error: Error) => void
}

type Send = (message: OutgoingMessage) => void

type ExchangeType =
  'command' | 'command.result' | 'ask' | 'ask.answer' | 'ask.cancel' | 'ask.abort' | 'request' | 'response'

const CANCEL: AskReply = { kind: 'cancel' }

const failure = (error: unknown): Outcome => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
})

const outcomeOf = (message: NodeMessageOf<'command.result'> | NodeMessageOf<'response'>): Outcome =>
  message.ok ? { ok: true, body: message.body } : { ok: false, error: message.error }

/** Commands, asks and requests in both directions, each matched to its reply by id. */
export class Exchange {
  private readonly handlers: ExchangeHandlers
  private readonly stores: ExchangeStores
  private readonly commands = new Map<string, Pending<Outcome>>()
  private readonly asks = new Map<string, Pending<AskResult>>()
  private readonly requests = new Map<string, Pending<Outcome>>()
  private readonly running = new Map<string, Promise<Outcome>>()
  private readonly answering = new Map<string, { reply: Promise<AskReply>; abort: AbortController }>()
  private send: Send | null = null

  constructor(handlers: ExchangeHandlers, stores: ExchangeStores) {
    this.handlers = handlers
    this.stores = stores
  }

  /** Sends again every command and ask still waiting for its reply. */
  attach(send: Send): void {
    this.send = send
    for (const pending of [...this.commands.values(), ...this.asks.values()]) {
      send(pending.message)
    }
  }

  /** Fails every open request; commands and asks wait for the next connection. */
  detach(): void {
    this.send = null
    for (const pending of this.requests.values()) {
      pending.fail(new OfflineError('the link closed before the response'))
    }
    this.requests.clear()
  }

  /** Runs a command on the peer once per id, however often it is sent. */
  async command(message: Omit<NodeMessageOf<'command'>, 'v' | 'type'>): Promise<Outcome> {
    return this.open(this.commands, { ...message, type: 'command' })
  }

  async ask(message: Omit<NodeMessageOf<'ask'>, 'v' | 'type'>, signal?: AbortSignal): Promise<AskResult> {
    const result = this.open(this.asks, { ...message, type: 'ask' })
    signal?.addEventListener('abort', () => {
      const pending = this.asks.get(message.id)
      if (pending !== undefined) {
        this.asks.delete(message.id)
        this.send?.({ type: 'ask.abort', id: message.id })
        pending.settle({ kind: 'aborted' })
      }
    })
    return result
  }

  /** Not durable: fails at once when the link is down and when it drops before the response. */
  async request(message: Omit<NodeMessageOf<'request'>, 'v' | 'type' | 'id'>): Promise<Outcome> {
    if (this.send === null) {
      throw new OfflineError('the link is down')
    }
    return this.open(this.requests, { ...message, type: 'request', id: randomUUID() })
  }

  /** The handlers for the messages this exchange owns. */
  routes(): Pick<MessageRoutes, ExchangeType> {
    return {
      command: (message) => void this.runCommand(message),
      'command.result': (message) => {
        this.settle(this.commands, message.id, outcomeOf(message))
      },
      ask: (message) => void this.answer(message),
      'ask.answer': (message) => {
        this.settle(this.asks, message.id, { kind: 'answer', body: message.body })
      },
      'ask.cancel': (message) => {
        this.settle(this.asks, message.id, CANCEL)
      },
      'ask.abort': (message) => {
        this.answering.get(message.id)?.abort.abort()
      },
      request: (message) => void this.serve(message),
      response: (message) => {
        this.settle(this.requests, message.id, outcomeOf(message))
      },
    }
  }

  private async open<T>(pending: Map<string, Pending<T>>, message: OutgoingMessage & { id: string }): Promise<T> {
    this.send?.(message)
    const existing = pending.get(message.id)
    if (existing !== undefined) {
      return existing.reply
    }
    let settle: (value: T) => void = () => undefined
    let fail: (error: Error) => void = () => undefined
    const reply = new Promise<T>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    pending.set(message.id, { message, reply, settle, fail })
    return reply
  }

  private settle<T>(pending: Map<string, Pending<T>>, id: string, value: T): void {
    const waiting = pending.get(id)
    pending.delete(id)
    waiting?.settle(value)
  }

  private async runCommand(message: NodeMessageOf<'command'>): Promise<void> {
    let outcome = this.running.get(message.id)
    if (outcome === undefined) {
      outcome = this.execute(message)
      this.running.set(message.id, outcome)
    }
    const result = await outcome
    this.running.delete(message.id)
    const reply = result.ok
      ? { type: 'command.result' as const, id: message.id, ok: true as const, body: result.body }
      : { type: 'command.result' as const, id: message.id, ok: false as const, error: result.error }
    this.send?.(reply)
  }

  private async execute(message: NodeMessageOf<'command'>): Promise<Outcome> {
    const stored = await this.stores.commandResults.get(message.id)
    if (stored !== undefined) {
      return stored
    }
    const handler = this.handlers.command
    const outcome: Outcome =
      handler === undefined
        ? { ok: false, error: 'commands are not accepted here' }
        : await handler(message).then((body) => ({ ok: true as const, body }), failure)
    await this.stores.commandResults.put(message.id, outcome)
    return outcome
  }

  private async answer(message: NodeMessageOf<'ask'>): Promise<void> {
    let current = this.answering.get(message.id)
    if (current === undefined) {
      const abort = new AbortController()
      current = { reply: this.reply(message, abort.signal), abort }
      this.answering.set(message.id, current)
    }
    try {
      const reply = await current.reply
      this.send?.(
        reply.kind === 'answer'
          ? { type: 'ask.answer', id: message.id, body: reply.body }
          : { type: 'ask.cancel', id: message.id },
      )
    } catch {
      // An aborted ask gets no reply; the asker has stopped waiting.
    } finally {
      this.answering.delete(message.id)
    }
  }

  private async reply(message: NodeMessageOf<'ask'>, signal: AbortSignal): Promise<AskReply> {
    const stored = await this.stores.askAnswers.get(message.id)
    if (stored !== undefined) {
      return stored
    }
    const handler = this.handlers.ask
    const reply = handler === undefined ? CANCEL : await handler(message, signal).catch(() => null)
    if (signal.aborted) {
      throw new Error('ask aborted')
    }
    if (reply === null) {
      return CANCEL
    }
    await this.stores.askAnswers.put(message.id, reply)
    return reply
  }

  private async serve(message: NodeMessageOf<'request'>): Promise<void> {
    const handler = this.handlers.request
    const outcome: Outcome =
      handler === undefined
        ? { ok: false, error: 'requests are not accepted here' }
        : await handler(message).then((body) => ({ ok: true as const, body }), failure)
    this.send?.(
      outcome.ok
        ? { type: 'response', id: message.id, ok: true, body: outcome.body }
        : { type: 'response', id: message.id, ok: false, error: outcome.error },
    )
  }
}
