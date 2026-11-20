import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { decodeNodeMessage, type NodeMessage } from '@seti/shared'
import { DEFAULT_MAX_FRAME_BYTES, encodeFrame, FrameDecoder, type Frame, type FrameError } from './frames.js'
import { Outbox } from './outbox.js'

/** Bulk bytes travel in slices of at most this size, so a large upload never blocks an ask. */
export const BULK_CHUNK_BYTES = 64 * 1024

const CLOSE_GRACE_MS = 5_000

/** Why a connection closed. */
export type CloseReason =
  | { kind: 'ended' }
  | { kind: 'local'; reason: string }
  | { kind: 'frame'; error: FrameError }
  | { kind: 'invalid'; error: string }
  | { kind: 'error'; message: string }

type Unstamped<M> = M extends unknown ? Omit<M, 'v' | 'id'> & { id?: string } : never

/** A message before sending: the connection adds the version, and an id when it has none. */
export type OutgoingMessage = Unstamped<NodeMessage>

export interface ConnectionListener {
  message(message: NodeMessage): void
  bulk?(stream: number, offset: number, data: Buffer): void
  unsupported?(type: string): void
  close(reason: CloseReason): void
}

type Inbound =
  | { kind: 'message'; message: NodeMessage }
  | { kind: 'bulk'; stream: number; offset: number; data: Buffer }
  | { kind: 'unsupported'; type: string }

export interface ConnectionOptions {
  /** The version stamped on sent messages until the handshake settles one. */
  version: number
  maxFrameBytes?: number
}

/** Protocol messages over a framed byte stream; holds what arrives while no one listens. */
export class LinkConnection {
  private readonly socket: Duplex
  private readonly decoder: FrameDecoder
  private readonly outbox: Outbox
  private readonly maxFrameBytes: number
  private readonly held: Inbound[] = []
  private listener: ConnectionListener | null = null
  private reason: CloseReason | null = null
  private finished = false
  private version: number

  constructor(socket: Duplex, options: ConnectionOptions) {
    this.socket = socket
    this.version = options.version
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    this.decoder = new FrameDecoder(this.maxFrameBytes)
    this.outbox = new Outbox(socket)
    socket.on('data', (chunk: Buffer) => {
      this.receive(chunk)
    })
    socket.on('end', () => {
      const error = this.decoder.end()
      this.fail(error === null ? { kind: 'ended' } : { kind: 'frame', error })
    })
    socket.on('error', (error) => {
      this.reason ??= { kind: 'error', message: error.message }
    })
    socket.on('close', () => {
      this.finish()
    })
  }

  get closed(): boolean {
    return this.finished || this.reason !== null
  }

  /** Stamps later messages with the version both sides agreed on. */
  useVersion(version: number): void {
    this.version = version
  }

  /** Hands what arrives to `listener`; with null, holds it for the next listener. */
  listen(listener: ConnectionListener | null): void {
    this.listener = listener
    while (listener !== null && this.listener === listener) {
      const item = this.held.shift()
      if (item === undefined) {
        if (this.finished && this.reason !== null) {
          listener.close(this.reason)
        }
        return
      }
      this.deliver(listener, item)
    }
  }

  send(message: OutgoingMessage): void {
    const stamped = { ...message, v: this.version, id: message.id ?? randomUUID() }
    const frame = encodeFrame({ kind: 'json', text: JSON.stringify(stamped) })
    if (frame.length - 4 > this.maxFrameBytes) {
      throw new Error(`${message.type} message is over the frame limit`)
    }
    this.outbox.push(message.type.startsWith('journal.') ? 'journal' : 'control', frame)
  }

  /** Sends `data` from `offset` of `stream` in slices of at most 64 KB. */
  sendBulk(stream: number, offset: number, data: Buffer): void {
    for (let start = 0; start < data.length; start += BULK_CHUNK_BYTES) {
      const slice = data.subarray(start, start + BULK_CHUNK_BYTES)
      this.outbox.push('bulk', encodeFrame({ kind: 'binary', stream, offset: offset + start, data: slice }))
    }
  }

  /** Says bye, flushes what is queued and ends the stream. */
  close(reason: string): void {
    if (this.closed) {
      return
    }
    this.send({ type: 'bye', reason })
    this.reason = { kind: 'local', reason }
    this.outbox.end()
    setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS).unref()
  }

  private receive(chunk: Buffer): void {
    const { frames, error } = this.decoder.push(chunk)
    for (const frame of frames) {
      if (this.reason !== null && this.reason.kind !== 'local') {
        return
      }
      this.accept(frame)
    }
    if (error !== null) {
      this.fail({ kind: 'frame', error })
    }
  }

  private accept(frame: Frame): void {
    if (frame.kind === 'binary') {
      this.inbound({ kind: 'bulk', stream: frame.stream, offset: frame.offset, data: frame.data })
      return
    }
    const decoded = decodeNodeMessage(frame.text)
    if (decoded.kind === 'invalid') {
      this.fail({ kind: 'invalid', error: decoded.error })
      return
    }
    this.inbound(decoded.kind === 'message' ? decoded : { kind: 'unsupported', type: decoded.type })
  }

  private inbound(item: Inbound): void {
    if (this.listener === null) {
      this.held.push(item)
      return
    }
    this.deliver(this.listener, item)
  }

  private deliver(listener: ConnectionListener, item: Inbound): void {
    if (item.kind === 'message') {
      listener.message(item.message)
    } else if (item.kind === 'bulk') {
      listener.bulk?.(item.stream, item.offset, item.data)
    } else {
      listener.unsupported?.(item.type)
    }
  }

  private fail(reason: CloseReason): void {
    this.reason ??= reason
    this.socket.destroy()
  }

  private finish(): void {
    if (this.finished) {
      return
    }
    this.finished = true
    this.reason ??= { kind: 'ended' }
    if (this.listener !== null && this.held.length === 0) {
      this.listener.close(this.reason)
    }
  }
}
