/** The largest frame a link accepts by default: 4 MiB of kind byte and payload. */
export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024

const LENGTH_BYTES = 4
const BINARY_HEADER_BYTES = 16
const KIND_JSON = 1
const KIND_BINARY = 2

/** A JSON text message, or a slice of a byte stream at an offset. */
export type Frame = { kind: 'json'; text: string } | { kind: 'binary'; stream: number; offset: number; data: Buffer }

/** Why a byte stream stopped being a valid sequence of frames. */
export interface FrameError {
  code: 'oversized' | 'malformed' | 'unknown-kind' | 'truncated'
  message: string
}

/** Layout: 4-byte big-endian length of what follows, 1 kind byte, then the payload. */
export function encodeFrame(frame: Frame): Buffer {
  const payload =
    frame.kind === 'json'
      ? Buffer.from(frame.text, 'utf8')
      : Buffer.concat([binaryHeader(frame.stream, frame.offset), frame.data])
  const head = Buffer.alloc(LENGTH_BYTES + 1)
  head.writeUInt32BE(payload.length + 1, 0)
  head.writeUInt8(frame.kind === 'json' ? KIND_JSON : KIND_BINARY, LENGTH_BYTES)
  return Buffer.concat([head, payload])
}

function binaryHeader(stream: number, offset: number): Buffer {
  const header = Buffer.alloc(BINARY_HEADER_BYTES)
  header.writeBigUInt64BE(BigInt(stream), 0)
  header.writeBigUInt64BE(BigInt(offset), 8)
  return header
}

function decodeBody(body: Buffer): Frame | FrameError {
  const kind = body.readUInt8(0)
  const payload = body.subarray(1)
  if (kind === KIND_JSON) {
    return { kind: 'json', text: payload.toString('utf8') }
  }
  if (kind !== KIND_BINARY) {
    return { code: 'unknown-kind', message: `unknown frame kind ${String(kind)}` }
  }
  if (payload.length < BINARY_HEADER_BYTES) {
    return { code: 'malformed', message: 'binary frame shorter than its header' }
  }
  const stream = payload.readBigUInt64BE(0)
  const offset = payload.readBigUInt64BE(8)
  if (stream > BigInt(Number.MAX_SAFE_INTEGER) || offset > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { code: 'malformed', message: 'binary frame header out of range' }
  }
  const data = Buffer.from(payload.subarray(BINARY_HEADER_BYTES))
  return { kind: 'binary', stream: Number(stream), offset: Number(offset), data }
}

export interface DecodedFrames {
  frames: Frame[]
  error: FrameError | null
}

/** Cuts a byte stream into frames; after the first error it decodes nothing more. */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private buffered = 0
  private failure: FrameError | null = null
  private readonly maxFrameBytes: number

  constructor(maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes
  }

  push(chunk: Buffer): DecodedFrames {
    const frames: Frame[] = []
    if (this.failure !== null) {
      return { frames, error: this.failure }
    }
    this.chunks.push(chunk)
    this.buffered += chunk.length
    while (this.buffered >= LENGTH_BYTES) {
      const length = this.peekLength()
      if (length === 0) {
        return { frames, error: this.fail({ code: 'malformed', message: 'empty frame' }) }
      }
      if (length > this.maxFrameBytes) {
        const message = `frame of ${String(length)} bytes is over ${String(this.maxFrameBytes)}`
        return { frames, error: this.fail({ code: 'oversized', message }) }
      }
      if (this.buffered < LENGTH_BYTES + length) {
        break
      }
      const decoded = decodeBody(this.take(length))
      if ('code' in decoded) {
        return { frames, error: this.fail(decoded) }
      }
      frames.push(decoded)
    }
    return { frames, error: null }
  }

  /** The error for a stream that ended inside a frame, if it did. */
  end(): FrameError | null {
    if (this.failure === null && this.buffered > 0) {
      return this.fail({ code: 'truncated', message: 'stream ended inside a frame' })
    }
    return this.failure
  }

  private fail(error: FrameError): FrameError {
    this.failure = error
    this.chunks = []
    this.buffered = 0
    return error
  }

  private peekLength(): number {
    const [first] = this.chunks
    const head = first !== undefined && first.length >= LENGTH_BYTES ? first : this.flatten()
    return head.readUInt32BE(0)
  }

  private flatten(): Buffer {
    const [first] = this.chunks
    if (this.chunks.length === 1 && first !== undefined) {
      return first
    }
    const joined = Buffer.concat(this.chunks)
    this.chunks = [joined]
    return joined
  }

  private take(length: number): Buffer {
    const all = this.flatten()
    const body = all.subarray(LENGTH_BYTES, LENGTH_BYTES + length)
    const rest = all.subarray(LENGTH_BYTES + length)
    this.chunks = rest.length > 0 ? [rest] : []
    this.buffered = rest.length
    return body
  }
}
