import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hostProxies, subdomainProxy, wasProxied } from './subdomain-proxy.js'

const upstream = { origin: '' }

const PROXY_HOST = 'demo-pr-7.seti.localhost:3101'

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString()
}

const server = http.createServer((req, res) => {
  void (async () => {
    if (req.url === '/page') {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'set-cookie': ['sid=1; Domain=example.test; Path=/; SameSite=Lax'],
      })
      res.end(gzipSync('<h1>preview</h1>'))
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `${upstream.origin}/page` })
      res.end()
      return
    }
    const body = await readBody(req)
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, method: req.method, body, headers: req.headers }))
  })()
})

const app = new Hono()
const flagged: boolean[] = []
app.use('*', async (c, next) => {
  await next()
  flagged.push(wasProxied(c.res))
})
app.use('*', subdomainProxy)
app.get('/api/system', (c) => c.text('seti api'))
app.get('*', (c) => c.text('seti page'))

const resolveDemo = async (host: string) =>
  Promise.resolve(host === 'demo-pr-7.seti.localhost' ? new URL(upstream.origin) : null)

type ProxyInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }

const request = async (path: string, init: ProxyInit = {}, host = PROXY_HOST) =>
  app.request(`http://${host}${path}`, { ...init, headers: { host, ...init.headers } })

let unregister = hostProxies.register({ key: 'test.demo', resolve: resolveDemo })

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  upstream.origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(() => {
  unregister()
  server.close()
})

describe('subdomainProxy', () => {
  it('leaves Seti hosts to the rest of the app', async () => {
    const res = await request('/api/system', {}, 'localhost:3101')
    expect(await res.text()).toBe('seti api')
  })

  it('still serves the older preview.localhost addresses', async () => {
    const res = await request('/page', {}, 'demo-pr-7.preview.localhost:3101')
    expect(res.status).toBe(200)
  })

  it('accepts the Seti iframe on the seti.localhost host', async () => {
    const headers = { 'sec-fetch-site': 'same-site', referer: 'http://seti.localhost:3101/' }
    expect((await request('/page', { headers })).status).toBe(200)
  })

  it('answers 404 on a subdomain nothing serves, never with a Seti page', async () => {
    const res = await request('/', {}, 'other-pr-1.seti.localhost:3101')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('seti page')
    expect(flagged.at(-1)).toBe(false)
  })

  it('marks only the responses it relayed, so they keep the upstream headers', async () => {
    expect((await request('/page')).status).toBe(200)
    expect(flagged.at(-1)).toBe(true)
    await request('/page', { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(flagged.at(-1)).toBe(false)
  })

  it('answers 404 on every subdomain once no proxy is registered', async () => {
    unregister()
    expect((await request('/page')).status).toBe(404)
    unregister = hostProxies.register({ key: 'test.demo', resolve: resolveDemo })
    expect((await request('/page')).status).toBe(200)
  })

  it('never serves the Seti API on a proxied host', async () => {
    const res = await request('/api/system')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ url: '/api/system', method: 'GET' })
  })

  it('makes the page frameable and keeps cookies on the proxy host', async () => {
    const res = await request('/page')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>preview</h1>')
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'")
    expect(res.headers.getSetCookie()).toEqual(['sid=1; Path=/; SameSite=None; Secure'])
  })

  it('keeps protocol-relative paths on the proxied host', async () => {
    const res = await request('//attacker.example/steal?x=1')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ url: '//attacker.example/steal?x=1' })
  })

  it('refuses cross-site requests that were not started by a Seti page', async () => {
    const forged = await request('/page', {
      headers: { 'sec-fetch-site': 'cross-site', referer: 'https://attacker.example/' },
    })
    expect(forged.status).toBe(403)
    const bare = await request('/page', { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(bare.status).toBe(403)
  })

  it('accepts the Seti iframe, same-origin requests and direct navigation', async () => {
    const embedded = { 'sec-fetch-site': 'same-site', referer: 'http://localhost:3101/' }
    for (const headers of [embedded, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }]) {
      expect((await request('/page', { headers })).status).toBe(200)
    }
  })

  it('returns redirects instead of following them, pointed at the proxy', async () => {
    const res = await request('/redirect')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`http://${PROXY_HOST}/page`)
  })

  it('forwards method, body and rewritten headers', async () => {
    const res = await request('/submit?x=1', {
      method: 'POST',
      body: 'name=seti',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: `http://${PROXY_HOST}`,
        referer: `http://${PROXY_HOST}/form`,
      },
    })
    const echo = (await res.json()) as { method: string; url: string; body: string; headers: Record<string, string> }
    const target = new URL(upstream.origin)
    expect(echo).toMatchObject({ method: 'POST', url: '/submit?x=1', body: 'name=seti' })
    expect(echo.headers).toMatchObject({
      host: target.host,
      origin: target.origin,
      referer: `${target.origin}/form`,
    })
  })
})
