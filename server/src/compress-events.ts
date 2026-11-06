import { once } from 'node:events'
import { constants, createGzip } from 'node:zlib'
import type { MiddlewareHandler } from 'hono'

const acceptsGzip = (header: string | undefined) =>
  (header ?? '').split(',').some((part) => {
    const [name = '', ...params] = part.trim().split(';')
    return name.trim() === 'gzip' && !params.some((param) => /^\s*q=0(\.0*)?\s*$/.test(param))
  })

/** Gzips a stream, flushing after every chunk so each event reaches the client at once. */
function gzipEachChunk(): TransformStream<Uint8Array, Uint8Array> {
  const gzip = createGzip()
  const flush = async () =>
    new Promise<void>((resolve) => {
      gzip.flush(constants.Z_SYNC_FLUSH, resolve)
    })
  return new TransformStream({
    start(controller) {
      // Read as zlib writes: an event larger than its buffer stalls the flush until read.
      gzip.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
      })
    },
    async transform(chunk) {
      gzip.write(chunk)
      await flush()
    },
    async flush() {
      const ended = once(gzip, 'end')
      gzip.end()
      await ended
    },
    cancel() {
      gzip.destroy()
    },
  })
}

/**
 * Gzips server-sent event streams, which Cloudflare passes through uncompressed. A task's backlog
 * shrinks about five times; other responses are left to Cloudflare.
 */
export const compressEventStreams: MiddlewareHandler = async (c, next) => {
  await next()
  const res = c.res
  const type = res.headers.get('content-type') ?? ''
  if (!type.startsWith('text/event-stream') || res.body === null || res.headers.has('content-encoding')) {
    return
  }
  if (!acceptsGzip(c.req.header('accept-encoding'))) {
    return
  }
  const headers = new Headers(res.headers)
  headers.set('Content-Encoding', 'gzip')
  headers.append('Vary', 'Accept-Encoding')
  headers.delete('Content-Length')
  // eslint-disable-next-line no-param-reassign -- Hono takes a wrapped response only through c.res
  c.res = new Response(res.body.pipeThrough(gzipEachChunk()), { status: res.status, headers })
}
