import { gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { describe, expect, it } from 'vitest'
import { compressEventStreams } from './compress-events.js'
import { jsonEtag } from './etag.js'

let count = 1

const app = new Hono()
app.use('/api/*', compressEventStreams)
app.use('/api/*', jsonEtag)
app.get('/api/count', (c) => c.json({ data: { count } }))
app.post('/api/count', (c) => c.json({ data: { count } }))
app.get('/api/missing', (c) => c.json({ error: { title: 'Not found', detail: 'Not found' } }, 404))
app.get('/api/events', (c) =>
  streamSSE(c, async (sse) => {
    await sse.writeSSE({ data: 'one' })
  }),
)
app.get('/api/file.json', (c) =>
  c.body('{"a":1}', 200, {
    'Content-Type': 'application/json',
    'Content-Length': '7',
    'Content-Disposition': 'inline',
  }),
)

const get = async (path: string, tag?: string) =>
  app.request(path, tag === undefined ? {} : { headers: { 'If-None-Match': tag } })

describe('jsonEtag', () => {
  it('tags a JSON GET and answers 304 with no body while the body is the same', async () => {
    count = 1
    const first = await get('/api/count')
    const tag = first.headers.get('etag')
    expect(first.status).toBe(200)
    expect(tag).toMatch(/^"[\w-]+"$/)
    expect(await first.json()).toEqual({ data: { count: 1 } })

    const again = await get('/api/count', tag ?? '')
    expect(again.status).toBe(304)
    expect(again.headers.get('etag')).toBe(tag)
    expect(await again.text()).toBe('')
  })

  it('matches a tag a proxy marked weak, and any tag in a list', async () => {
    count = 1
    const tag = (await get('/api/count')).headers.get('etag') ?? ''
    expect((await get('/api/count', `W/${tag}`)).status).toBe(304)
    expect((await get('/api/count', `"other", ${tag}`)).status).toBe(304)
  })

  it('answers 200 with a new tag once the body changes', async () => {
    count = 1
    const tag = (await get('/api/count')).headers.get('etag') ?? ''
    count = 2
    const changed = await get('/api/count', tag)
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(tag)
    expect(changed.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await changed.json()).toEqual({ data: { count: 2 } })
  })

  it('leaves SSE, errors, writes and sized files untouched', async () => {
    const events = await get('/api/events', '*')
    expect(events.status).toBe(200)
    expect(events.headers.get('etag')).toBeNull()
    expect(await events.text()).toContain('data: one')

    const missing = await get('/api/missing')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('etag')).toBeNull()

    const posted = await app.request('/api/count', { method: 'POST', headers: { 'If-None-Match': '*' } })
    expect(posted.status).toBe(200)
    expect(posted.headers.get('etag')).toBeNull()

    const file = await get('/api/file.json', '*')
    expect(file.status).toBe(200)
    expect(file.headers.get('etag')).toBeNull()
  })

  it('leaves a gzipped event stream to compression, with no tag and its body intact', async () => {
    const res = await app.request('/api/events', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': '*' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBeNull()
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toContain('data: one')
  })
})
