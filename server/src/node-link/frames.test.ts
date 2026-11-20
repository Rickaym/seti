import { duplexPair, Writable } from 'node:stream'
import { decodeNodeMessage } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { BULK_CHUNK_BYTES, LinkConnection, type CloseReason } from './connection.js'
import { encodeFrame, FrameDecoder, type Frame } from './frames.js'
import { Outbox } from './outbox.js'

const json: Frame = { kind: 'json', text: '{"v":1,"type":"ping","id":"p"}' }
const binary: Frame = { kind: 'binary', stream: 7, offset: 2 ** 40, data: Buffer.from([1, 2, 3]) }

const header = (length: number, kind: number) => {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(length, 0)
  head.writeUInt8(kind, 4)
  return head
}

describe('frames', () => {
  it('round trips JSON and binary frames, whole or a byte at a time', () => {
    const bytes = Buffer.concat([encodeFrame(json), encodeFrame(binary), encodeFrame(json)])
    expect(new FrameDecoder().push(bytes)).toEqual({ frames: [json, binary, json], error: null })
    const decoder = new FrameDecoder()
    const frames = [...bytes].flatMap((byte) => decoder.push(Buffer.from([byte])).frames)
    expect(frames).toEqual([json, binary, json])
    expect(decoder.end()).toBeNull()
  })

  it('reports a stream that ends inside a frame as truncated', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(encodeFrame(json).subarray(0, 9)).frames).toEqual([])
    expect(decoder.end()?.code).toBe('truncated')
  })

  it('refuses an oversized frame from its header alone', () => {
    const decoder = new FrameDecoder(1024)
    expect(decoder.push(header(1025, 1)).error?.code).toBe('oversized')
    const after = decoder.push(encodeFrame(json))
    expect(after.frames).toEqual([])
    expect(after.error?.code).toBe('oversized')
  })

  it('refuses an empty frame, an unknown kind and a binary frame without its header', () => {
    expect(new FrameDecoder().push(header(0, 1).subarray(0, 4)).error?.code).toBe('malformed')
    expect(new FrameDecoder().push(Buffer.concat([header(2, 9), Buffer.from('x')])).error?.code).toBe('unknown-kind')
    expect(new FrameDecoder().push(Buffer.concat([header(4, 2), Buffer.from('abc')])).error?.code).toBe('malformed')
  })

  it('keeps the frames before an error', () => {
    const { frames, error } = new FrameDecoder().push(
      Buffer.concat([encodeFrame(json), header(2, 9), Buffer.from('x')]),
    )
    expect(frames).toEqual([json])
    expect(error?.code).toBe('unknown-kind')
  })
})

function connected() {
  const [local, remote] = duplexPair()
  const connection = new LinkConnection(local, { version: 1, maxFrameBytes: 4096 })
  const closed = new Promise<CloseReason>((resolve) => {
    connection.listen({ message: () => undefined, close: resolve })
  })
  return { connection, remote, closed }
}

describe('LinkConnection', () => {
  it('closes on bad JSON with a typed reason', async () => {
    const { remote, closed } = connected()
    remote.write(encodeFrame({ kind: 'json', text: '{oops' }))
    await expect(closed).resolves.toEqual({ kind: 'invalid', error: 'not JSON' })
  })

  it('closes on an oversized frame and on a truncated one', async () => {
    const big = connected()
    big.remote.write(header(5000, 1))
    await expect(big.closed).resolves.toMatchObject({ kind: 'frame', error: { code: 'oversized' } })
    const cut = connected()
    cut.remote.end(encodeFrame(json).subarray(0, 8))
    await expect(cut.closed).resolves.toMatchObject({ kind: 'frame', error: { code: 'truncated' } })
  })

  it('passes unknown types on as unsupported and holds messages until someone listens', async () => {
    const [local, remote] = duplexPair()
    const connection = new LinkConnection(local, { version: 1 })
    remote.write(encodeFrame({ kind: 'json', text: '{"v":1,"type":"warp","id":"w"}' }))
    remote.write(encodeFrame(json))
    await new Promise((resolve) => setImmediate(resolve))
    const seen: string[] = []
    connection.listen({
      message: (message) => seen.push(message.type),
      unsupported: (type) => seen.push(`unsupported ${type}`),
      close: () => undefined,
    })
    expect(seen).toEqual(['unsupported warp', 'ping'])
  })

  it('stamps the version and an id, and refuses a message over the frame limit', async () => {
    const { connection, remote } = connected()
    const written: Buffer[] = []
    remote.on('data', (chunk: Buffer) => written.push(chunk))
    connection.useVersion(3)
    connection.send({ type: 'ping' })
    expect(() => {
      connection.send({ type: 'bye', reason: 'x'.repeat(5000) })
    }).toThrow(/frame limit/)
    await new Promise((resolve) => setImmediate(resolve))
    const [frame] = new FrameDecoder().push(Buffer.concat(written)).frames
    const decoded = frame?.kind === 'json' ? decodeNodeMessage(frame.text) : null
    expect(decoded?.kind === 'message' && decoded.message).toMatchObject({ v: 3, type: 'ping' })
    expect(decoded?.kind === 'message' && decoded.message.id.length).toBeGreaterThan(0)
  })
})

describe('Outbox', () => {
  it('sends asks and commands first, journal second and bulk last, in 64 KB slices', async () => {
    const order: string[] = []
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, done) {
        const text = chunk.subarray(5).toString()
        order.push(chunk.readUInt8(4) === 2 ? 'bulk' : (JSON.parse(text) as { type: string }).type)
        setImmediate(done)
      },
    })
    const outbox = new Outbox(slow)
    const frame = (type: string) => encodeFrame({ kind: 'json', text: JSON.stringify({ type }) })
    for (let offset = 0; offset < 3 * BULK_CHUNK_BYTES; offset += BULK_CHUNK_BYTES) {
      outbox.push('bulk', encodeFrame({ kind: 'binary', stream: 1, offset, data: Buffer.alloc(BULK_CHUNK_BYTES) }))
    }
    outbox.push('journal', frame('journal.append'))
    outbox.push('control', frame('ask'))
    outbox.push('control', frame('command'))
    outbox.end()
    await new Promise((resolve) => slow.on('finish', resolve))
    expect(order).toEqual(['bulk', 'ask', 'command', 'journal.append', 'bulk', 'bulk'])
  })

  it('cuts bulk data into slices of at most 64 KB with advancing offsets', async () => {
    const [local, remote] = duplexPair()
    const connection = new LinkConnection(local, { version: 1 })
    const frames: Frame[] = []
    const decoder = new FrameDecoder()
    remote.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk).frames))
    connection.sendBulk(4, 100, Buffer.alloc(BULK_CHUNK_BYTES * 2 + 10))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(frames.map((frame) => (frame.kind === 'binary' ? [frame.offset, frame.data.length] : []))).toEqual([
      [100, BULK_CHUNK_BYTES],
      [100 + BULK_CHUNK_BYTES, BULK_CHUNK_BYTES],
      [100 + 2 * BULK_CHUNK_BYTES, 10],
    ])
  })
})
