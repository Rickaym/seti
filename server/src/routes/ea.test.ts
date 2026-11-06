import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { auditEvents } from '../store/audit.js'
import { USER_AUTH } from '../test-auth.js'

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

interface Reply {
  status: number
  body: string
  type?: string
  /** Sent after `body` once this settles, then the answer ends. */
  rest?: { after: Promise<void>; body: string }
}

const seen: Seen[] = []
const closed: string[] = []
const replies = new Map<string, Reply>()

const bot = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers }
    seen.push({ ...entry, body: Buffer.concat(chunks).toString('utf8') })
    const reply = replies.get(`${entry.method} ${entry.url}`) ?? { status: 404, body: '{"detail":"Not Found"}' }
    res.writeHead(reply.status, { 'content-type': reply.type ?? 'application/json', 'set-cookie': 'bot=1' })
    res.on('close', () => {
      closed.push(`${entry.method} ${entry.url}`)
    })
    const { rest } = reply
    if (rest === undefined) {
      res.end(reply.body)
      return
    }
    res.write(reply.body)
    void rest.after.then(() => res.end(rest.body))
  })
})

const listen = async (server: http.Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })

/** A port that was just free, so nothing answers there. */
async function closedPort(): Promise<number> {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

let botHost = ''
let app: ReturnType<typeof createApp>
let downApp: ReturnType<typeof createApp>

beforeAll(async () => {
  const port = await listen(bot)
  botHost = `127.0.0.1:${String(port)}`
  app = createApp({ access: null, verify: null }, `http://127.0.0.1:${String(port)}`)
  downApp = createApp({ access: null, verify: null }, `http://127.0.0.1:${String(await closedPort())}`)
})

afterAll(async () => {
  await new Promise((resolve) => bot.close(resolve))
})

beforeEach(() => {
  seen.length = 0
  closed.length = 0
  replies.clear()
})

const LOCAL = { host: 'seti.localhost:3006', ...USER_AUTH, origin: 'http://seti.localhost:3006' }

async function send(target: ReturnType<typeof createApp>, method: string, path: string, body?: string) {
  return target.request(`/api/ea${path}`, {
    method,
    headers: {
      ...LOCAL,
      cookie: 'session=secret',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  })
}

const OFFER =
  '{"sdp":"v=0\\r\\no=- 1 2 IN IP4 127.0.0.1\\r\\n",  "type":"offer","pc_id":null,"restart_pc":false,"requestData":{"a":1}}'
const PATCH =
  '{"pc_id":"pc-1","candidates":[{"candidate":"candidate:1 1 udp 1 10.0.0.1 5000 typ host","sdp_mid":"0","sdp_mline_index":0}]}'

describe('EA proxy with the bot up', () => {
  it('passes health and ICE answers through without caching', async () => {
    const health = '{"ok":true,"configured":false,"missing":["DEEPGRAM_API_KEY"],"model":null,"turn":false}'
    replies.set('GET /health', { status: 200, body: health })
    replies.set('GET /ice', { status: 200, body: '{"iceServers":[{"urls":"stun:stun.cloudflare.com:3478"}]}' })

    const res = await send(app, 'GET', '/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await res.text()).toBe(health)

    const ice = await send(app, 'GET', '/ice')
    expect(await ice.json()).toEqual({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /health', 'GET /ice'])
    expect(seen[0]?.headers.cookie).toBeUndefined()
  })

  it('forwards the offer body byte for byte and returns the answer', async () => {
    const answer = '{"sdp":"v=0\\r\\n","type":"answer","pc_id":"pc-1"}'
    replies.set('POST /offer', { status: 200, body: answer })
    const res = await send(app, 'POST', '/offer', OFFER)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(answer)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/offer', body: OFFER })
    expect(seen[0]?.headers['content-type']).toBe('application/json')
    expect(seen[0]?.headers.host).toBe(botHost)
    expect(seen[0]?.headers.origin).toBeUndefined()
  })

  it('forwards trickled ICE candidates with PATCH', async () => {
    replies.set('PATCH /offer', { status: 200, body: '{"status":"success"}' })
    const res = await send(app, 'PATCH', '/offer', PATCH)
    expect(res.status).toBe(200)
    expect(seen[0]).toMatchObject({ method: 'PATCH', url: '/offer', body: PATCH })
  })

  it('passes error statuses from the bot through', async () => {
    replies.set('POST /offer', { status: 500, body: '{"detail":"no keys"}' })
    const res = await send(app, 'POST', '/offer', OFFER)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ detail: 'no keys' })
  })

  it('rejects malformed bodies without calling the bot', async () => {
    const offer = await send(app, 'POST', '/offer', '{"sdp":"","type":"offer"}')
    expect(offer.status).toBe(400)
    const patch = await send(app, 'PATCH', '/offer', '{"candidates":[]}')
    expect(patch.status).toBe(400)
    const answer = await send(app, 'POST', '/offer', '{"sdp":"v=0","type":"answer"}')
    expect(answer.status).toBe(400)
    const zone = JSON.stringify({ sdp: 'v=0', type: 'offer', requestData: { timezone: 'x'.repeat(65) } })
    expect((await send(app, 'POST', '/offer', zone)).status).toBe(400)
    expect(seen).toEqual([])
  })

  it('streams a chat reply as it comes and audits the typed message', async () => {
    let finish: () => void = () => undefined
    const after = new Promise<void>((resolve) => {
      finish = resolve
    })
    const first = 'event: text\ndata: {"delta": "Two tasks"}\n\n'
    const rest = 'event: done\ndata: {"ids": [7]}\n\n'
    replies.set('POST /chat', { status: 200, body: first, type: 'text/event-stream', rest: { after, body: rest } })

    const body = JSON.stringify({ text: '  What is running?  ', requestData: { timezone: 'Europe/Berlin' } })
    const res = await send(app, 'POST', '/chat', body)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader()
    const decoder = new TextDecoder()
    const chunk = await reader?.read()
    expect(decoder.decode(chunk?.value)).toBe(first)
    finish()
    let tail = ''
    for (let next = await reader?.read(); next !== undefined && !next.done; next = await reader?.read()) {
      tail += decoder.decode(next.value)
    }
    expect(tail).toBe(rest)

    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      text: 'What is running?',
      requestData: { timezone: 'Europe/Berlin' },
    })
    expect(await auditEvents.latest('ea.chat_message')).toMatchObject({
      actor: 'user',
      subject_type: 'ea',
      summary: 'Sent the EA "What is running?"',
      detail: { text: 'What is running?' },
    })
  })

  it('stops the reply at the bot when the browser leaves', async () => {
    const hold = new Promise<void>(() => undefined)
    replies.set('POST /chat', {
      status: 200,
      body: 'event: text\ndata: {"delta": "Thinking"}\n\n',
      type: 'text/event-stream',
      rest: { after: hold, body: '' },
    })
    const res = await send(app, 'POST', '/chat', '{"text":"Plan my day"}')
    const reader = res.body?.getReader()
    await reader?.read()
    await reader?.cancel()
    await expect.poll(() => closed).toContain('POST /chat')
  })

  it('audits no message the bot turned away and never forwards a bad one', async () => {
    const before = await auditEvents.latest('ea.chat_message')
    replies.set('POST /chat', { status: 503, body: '{"error":{"title":"The EA is not configured","detail":"x"}}' })
    expect((await send(app, 'POST', '/chat', '{"text":"Hello"}')).status).toBe(503)
    for (const bad of ['{"text":"   "}', '{}', JSON.stringify({ text: 'x'.repeat(8001) })]) {
      expect((await send(app, 'POST', '/chat', bad)).status).toBe(400)
    }
    expect(seen).toHaveLength(1)
    expect(await auditEvents.latest('ea.chat_message')).toEqual(before)
  })

  it('answers a repeated typed message with the first reply and sends the EA nothing more', async () => {
    let finish: () => void = () => undefined
    const after = new Promise<void>((resolve) => {
      finish = resolve
    })
    replies.set('POST /chat', {
      status: 200,
      body: 'event: text\ndata: {"delta": "Hi"}\n\n',
      type: 'text/event-stream',
      rest: { after, body: 'event: done\ndata: {"ids": [41, 42]}\n\n' },
    })
    const audits = async () => (await auditEvents.page({ kind: 'ea.chat_message', limit: 500 })).events.length
    const before = await audits()
    const body = JSON.stringify({ text: 'Hello again', client_id: randomUUID() })
    const first = await send(app, 'POST', '/chat', body)
    const reader = first.body?.getReader()
    await reader?.read()
    await reader?.cancel()
    const repeat = send(app, 'POST', '/chat', body)
    finish()
    const done = 'event: done\ndata: {"ids":[41,42]}'
    expect(await (await repeat).text()).toContain(done)
    expect(await (await send(app, 'POST', '/chat', body)).text()).toContain(done)
    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ text: 'Hello again' })
    await auditEvents.settled()
    expect(await audits()).toBe(before + 1)
  })

  it('sends a typed message again when the EA turned the first copy away', async () => {
    const body = JSON.stringify({ text: 'Try twice', client_id: randomUUID() })
    replies.set('POST /chat', { status: 503, body: '{"error":{"title":"Busy","detail":"x"}}' })
    expect((await send(app, 'POST', '/chat', body)).status).toBe(503)
    replies.set('POST /chat', { status: 200, body: 'event: done\ndata: {"ids": [9]}\n\n', type: 'text/event-stream' })
    expect(await (await send(app, 'POST', '/chat', body)).text()).toContain('"ids": [9]')
    expect(seen).toHaveLength(2)
  })

  it('stays behind the host guard', async () => {
    const res = await app.request('/api/ea/health', { headers: { host: 'evil.example.com' } })
    expect(res.status).toBe(403)
    expect(seen).toEqual([])
  })
})

describe('EA proxy with the bot down', () => {
  it('reports the bot as not running on the health check', async () => {
    const res = await send(downApp, 'GET', '/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const payload = (await res.json()) as { running: boolean; reason: string }
    expect(payload.running).toBe(false)
    expect(payload.reason).toMatch(/^Nothing answers at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)$/)
  })

  it('answers 503 with a readable reason for the call endpoints', async () => {
    for (const [method, path, body] of [
      ['GET', '/ice', undefined],
      ['POST', '/offer', OFFER],
      ['PATCH', '/offer', PATCH],
      ['POST', '/chat', '{"text":"Hello"}'],
    ] as const) {
      const res = await send(downApp, method, path, body)
      expect(res.status, `${method} ${path}`).toBe(503)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const payload = (await res.json()) as { error: { title: string; detail: string } }
      expect(payload.error.title).toBe('EA is not running')
      expect(payload.error.detail).toMatch(/ECONNREFUSED/)
    }
  })
})
