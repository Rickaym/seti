import { randomBytes } from 'node:crypto'
import { constants, gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { describe, expect, it } from 'vitest'
import { compressEventStreams } from './compress-events.js'

function eventApp(onAbort: () => void = () => undefined) {
  const app = new Hono()
  app.use('*', compressEventStreams)
  app.get('/events', (c) =>
    streamSSE(c, async (sse) => {
      sse.onAbort(onAbort)
      await sse.writeSSE({ event: 'backlog', data: JSON.stringify({ rows: 'x'.repeat(4000) }) })
      await sse.writeSSE({ event: 'message', data: 'hello', id: '7' })
    }),
  )
  app.get('/json', (c) => c.json({ ok: true }))
  return app
}

const gzip = { 'accept-encoding': 'gzip, deflate, br' }

async function readAll(body: ReadableStream<Uint8Array>): Promise<Buffer[]> {
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk))
  }
  return chunks
}

describe('compressEventStreams', () => {
  it('gzips an event stream into the same events, much smaller', async () => {
    const res = await eventApp().request('/events', { headers: gzip })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toContain('Accept-Encoding')
    const body = res.body
    if (body === null) {
      throw new Error('no body')
    }
    const packed = Buffer.concat(await readAll(body))
    const text = gunzipSync(packed).toString()
    expect(text).toContain('event: backlog')
    expect(text).toContain('event: message\ndata: hello\nid: 7\n\n')
    expect(packed.length).toBeLessThan(text.length / 10)
  })

  it('streams an event larger than the zlib buffer instead of stalling', async () => {
    const big = randomBytes(750_000).toString('base64')
    const app = new Hono()
    app.use('*', compressEventStreams)
    app.get('/big', (c) =>
      streamSSE(c, async (sse) => {
        await sse.writeSSE({ event: 'backlog', data: big })
        await sse.writeSSE({ event: 'message', data: 'after' })
      }),
    )
    const res = await app.request('/big', { headers: gzip })
    const body = res.body
    if (body === null) {
      throw new Error('no body')
    }
    const text = gunzipSync(Buffer.concat(await readAll(body))).toString()
    expect(text).toContain(`event: backlog\ndata: ${big}\n\n`)
    expect(text).toContain('event: message\ndata: after')
  })

  it('flushes each event so it decodes while the stream stays open', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = new Hono()
    app.use('*', compressEventStreams)
    app.get('/held', (c) =>
      streamSSE(c, async (sse) => {
        await sse.writeSSE({ event: 'backlog', data: 'first' })
        await held
      }),
    )
    const res = await app.request('/held', { headers: gzip })
    const body: ReadableStream<Uint8Array> | null = res.body
    if (body === null) {
      throw new Error('no body')
    }
    const received: Buffer[] = []
    const decoded = () => gunzipSync(Buffer.concat(received), { finishFlush: constants.Z_SYNC_FLUSH }).toString()
    for await (const chunk of body) {
      received.push(Buffer.from(chunk))
      if (decoded().includes('event: backlog')) {
        break
      }
    }
    const text = decoded()
    expect(text).toContain('data: first')
    release()
  })

  it('stops the event source when the client goes away', async () => {
    let aborted = false
    const app = new Hono()
    app.use('*', compressEventStreams)
    app.get('/live', (c) =>
      streamSSE(c, async (sse) => {
        sse.onAbort(() => {
          aborted = true
        })
        await sse.writeSSE({ event: 'ping', data: '' })
        while (!aborted) {
          await sse.sleep(10)
          await sse.writeSSE({ event: 'ping', data: '' })
        }
      }),
    )
    const res = await app.request('/live', { headers: gzip })
    const reader = res.body?.getReader()
    await reader?.read()
    await reader?.cancel()
    await expect.poll(() => aborted).toBe(true)
  })

  it('leaves clients without gzip and other responses alone', async () => {
    const app = eventApp()
    const plain = await app.request('/events', { headers: { 'accept-encoding': 'identity' } })
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(await plain.text()).toContain('event: message')
    const refused = await app.request('/events', { headers: { 'accept-encoding': 'gzip;q=0' } })
    expect(refused.headers.get('content-encoding')).toBeNull()
    const json = await app.request('/json', { headers: gzip })
    expect(json.headers.get('content-encoding')).toBeNull()
  })
})
