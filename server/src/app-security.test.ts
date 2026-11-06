import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { API_BODY_MAX, createApp } from './app.js'
import { UI_DIST, type CloudflareAccess, type PublicAccess } from './config.js'
import { securityHeaders } from './security-headers.js'
import { USER_AUTH } from './test-auth.js'

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UI_DIST: path.join(process.env.SETI_HOME ?? '', 'ui-dist'),
}))

vi.mock('./runner.js', () => ({
  runTurn: () => undefined,
  stopTurn: async () => Promise.resolve(),
  endSession: async () => Promise.resolve(),
  isRunning: () => false,
  registerContextProvider: () => undefined,
  registerSessionMcpServers: () => undefined,
  registerTurnPreface: () => undefined,
  onTurnEnd: () => undefined,
  subscribe: () => () => undefined,
}))

const CLOUDFLARE: CloudflareAccess = { team: 'myteam.cloudflareaccess.com', aud: 'a'.repeat(64), allowed: null }
const ACCESS: PublicAccess = {
  hostname: 'seti.example.com',
  origin: 'https://seti.example.com',
  cloudflare: CLOUDFLARE,
}

const BUILT = {
  'index.html': '<!doctype html><title>Seti</title>',
  'sw.js': 'self.addEventListener("fetch", () => undefined)',
  'manifest.webmanifest': '{"name":"Seti"}',
  'assets/index-abc123.js': 'export {}',
}

for (const [file, body] of Object.entries(BUILT)) {
  fs.mkdirSync(path.dirname(path.join(UI_DIST, file)), { recursive: true })
  fs.writeFileSync(path.join(UI_DIST, file), body)
}

const app = createApp({ access: ACCESS, verify: async () => Promise.resolve('me@example.com') })

const directives = (policy: string | null) =>
  new Map(
    (policy ?? '').split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/)
      return [name, values.join(' ')] as const
    }),
  )

describe('security headers', () => {
  it('sends a strict policy on loopback pages without HSTS', async () => {
    const res = await app.request('/', { headers: { host: 'seti.localhost:3006', ...USER_AUTH } })
    const csp = directives(res.headers.get('content-security-policy'))
    expect(csp.get('default-src')).toBe("'self'")
    expect(csp.get('script-src')).toBe("'self' blob:")
    expect(csp.get('connect-src')).toBe("'self'")
    expect(csp.get('frame-src')).toBe("'self'")
    expect(csp.get('manifest-src')).toBe("'self'")
    expect(csp.get('worker-src')).toBe("'self' blob:")
    expect(csp.get('frame-ancestors')).toBe("'none'")
    expect(csp.get('object-src')).toBe("'none'")
    expect(csp.get('script-src')).not.toContain('unsafe')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('permissions-policy')).toBe(
      'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
    )
    expect(res.headers.get('strict-transport-security')).toBeNull()
  })

  it('keeps API responses out of caches', async () => {
    const res = await app.request('/api/system', { headers: { host: '127.0.0.1:3006', ...USER_AUTH } })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).not.toBeNull()
  })

  it('answers the latency ping with an empty, uncached reply that still needs Access', async () => {
    const local = await app.request('/api/ping', { headers: { host: '127.0.0.1:3006', ...USER_AUTH } })
    expect(local.status).toBe(204)
    expect(await local.text()).toBe('')
    expect(local.headers.get('cache-control')).toBe('no-store')
    const viaAccess = await app.request('/api/ping', {
      headers: { host: 'seti.example.com', 'cf-access-jwt-assertion': 'token' },
    })
    expect(viaAccess.status).toBe(204)
    expect((await app.request('/api/ping', { headers: { host: 'seti.example.com' } })).status).toBe(403)
  })

  it('adds HSTS on the public host, also to refusals', async () => {
    const ok = await app.request('/api/system', {
      headers: { host: 'seti.example.com', 'cf-access-jwt-assertion': 'token' },
    })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains')
    const refused = await app.request('/api/system', { headers: { host: 'seti.example.com' } })
    expect(refused.status).toBe(403)
    expect(refused.headers.get('strict-transport-security')).not.toBeNull()
    expect(refused.headers.get('content-security-policy')).not.toBeNull()
  })

  it('gives a subdomain no proxy serves a 404 with every Seti header', async () => {
    const res = await app.request('/', { headers: { host: 'web-pr-3.seti.localhost:3006', ...USER_AUTH } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('permissions-policy')).not.toBeNull()
  })

  it('keeps Seti headers on a subdomain response the proxy did not relay', async () => {
    const preview = new Hono()
    preview.use('*', securityHeaders(ACCESS))
    preview.get('*', (c) => c.text('preview', 200, { 'content-security-policy': "frame-src 'none'" }))
    const res = await preview.request('/', { headers: { host: 'web-pr-3.seti.localhost:3006' } })
    expect(res.headers.get('content-security-policy')).toBe("frame-src 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('permissions-policy')).not.toBeNull()
  })
})

describe('installable app', () => {
  const get = async (pathname: string) =>
    app.request(pathname, { headers: { host: 'seti.localhost:3006', ...USER_AUTH } })

  it('serves the manifest as a web app manifest that revalidates', async () => {
    const res = await get('/manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/manifest+json')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('content-security-policy')).not.toBeNull()
  })

  it('serves the service worker as a script that revalidates', async () => {
    const res = await get('/sw.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('revalidates the shell on every route', async () => {
    for (const pathname of ['/', '/index.html', '/tasks/abc']) {
      const res = await get(pathname)
      expect(res.status, pathname).toBe(200)
      expect(res.headers.get('content-type'), pathname).toMatch(/^text\/html/)
      expect(res.headers.get('cache-control'), pathname).toBe('no-cache')
    }
  })

  it('caches hashed assets for good and keeps the API out of caches', async () => {
    const asset = await get('/assets/index-abc123.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const api = await app.request('/api/system', { headers: { host: '127.0.0.1:3006', ...USER_AUTH } })
    expect(api.headers.get('cache-control')).toBe('no-store')
  })
})

describe('request size', () => {
  const post = async (body: string, headers: Record<string, string> = {}) =>
    app.request('/api/context/packs', {
      method: 'POST',
      headers: { host: '127.0.0.1:3006', ...USER_AUTH, 'content-type': 'application/json', ...headers },
      body,
    })

  it('refuses API bodies over the limit before they reach a route', async () => {
    const res = await post(JSON.stringify({ name: 'Huge', body: 'x'.repeat(API_BODY_MAX) }))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: { title: 'Request too large', detail: 'Request bodies are limited to 8 MB' },
    })
  })

  it('accepts ordinary bodies', async () => {
    const res = await post(JSON.stringify({ name: 'Small pack', body: 'Notes' }))
    expect(res.status).toBe(200)
  })
})
