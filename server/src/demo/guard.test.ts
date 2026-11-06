import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { DEMO_ALLOWLIST } from './allowlist.js'
import { DEMO_REFUSED_TITLE, demoGuard, routeKey } from './guard.js'
import { demoShell } from './login.js'
import { demoApp } from './serve.js'
import { modHost } from '../mods/bundled.js'

const inner = createApp()
const app = demoApp(inner, new Date(Date.now() + 3_600_000))

const keysOf = (hono: Hono) => [...new Set(hono.routes.map((route) => routeKey(route.method, route.path)))]

/** A path the route matches: each parameter and wildcard filled in. */
const concrete = (path: string) =>
  path
    .replace(/:[A-Za-z_]+(\{[^}]*\})?/g, 'demo1')
    .replace(/\/\*$/, '/demo1')
    .replace(/\*/g, 'demo1')

const methodOf = (key: string) => {
  const method = key.slice(0, key.indexOf(' '))
  return method === 'ALL' ? 'POST' : method
}

const ORIGIN = 'http://localhost'

async function send(method: string, path: string, body: unknown = {}) {
  const init: RequestInit = {
    method,
    headers: { host: 'localhost', origin: ORIGIN, 'content-type': 'application/json' },
  }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(body)
  }
  return app.request(path, init)
}

/** The refusal's title; a HEAD answer carries no body, so its 403 alone stands for it. */
async function refusedBody(res: Response): Promise<string> {
  if (res.status !== 403) {
    return `status ${String(res.status)}`
  }
  const text = await res.text()
  return text === '' ? DEMO_REFUSED_TITLE : (JSON.parse(text) as { error: { title: string } }).error.title
}

describe('the demo guard', () => {
  it('refuses every route of the app that the allowlist leaves out, so new routes start refused', async () => {
    const refused = keysOf(inner).filter((key) => !DEMO_ALLOWLIST.has(key))
    expect(refused.length).toBeGreaterThan(150)
    for (const key of refused) {
      const path = concrete(key.slice(key.indexOf(' ') + 1))
      expect(await refusedBody(await send(methodOf(key), path)), key).toBe(DEMO_REFUSED_TITLE)
    }
  })

  it('lists only routes the app has, so a renamed route cannot leave a stale opening', () => {
    const known = new Set(keysOf(app))
    expect([...DEMO_ALLOWLIST.keys()].filter((key) => !known.has(key))).toEqual([])
  })

  it('refuses the dangerous areas outright, terminals, shells, SSH, secrets, plugins and webhooks', async () => {
    const cases: [string, string][] = [
      ['GET', '/api/terminals/t1'],
      ['POST', '/api/tasks/demo1/shell'],
      ['POST', '/api/ssh/keys'],
      ['PUT', '/api/connections/c1/values/value'],
      ['PUT', '/api/credentials/profiles/default/github'],
      ['POST', '/api/plugins/installed'],
      ['POST', '/api/plugins/marketplaces'],
      ['POST', '/api/mcp/servers'],
      ['POST', '/api/channels/pollers'],
      ['POST', '/api/channels/reminders/test'],
      ['PUT', '/api/sandbox'],
      ['PUT', '/api/tasks/demo1/files/text'],
      ['POST', '/api/uploads'],
      ['POST', '/api/tasks'],
      ['POST', '/api/sessions/import'],
      ['POST', '/api/auth/passkeys/options'],
      ['POST', '/api/auth/setup'],
      ['POST', '/api/local-session'],
      ['POST', '/api/tasks/demo1/processes/stop'],
      ['POST', '/hooks/demo1'],
      ['GET', '/share/demo1'],
      ['HEAD', '/api/terminals/t1'],
    ]
    for (const [method, path] of cases) {
      expect(await refusedBody(await send(method, path)), `${method} ${path}`).toBe(DEMO_REFUSED_TITLE)
    }
  })

  it('takes only the fields it allows on writes, so no request can point an agent at a path', async () => {
    const cases: [string, string, unknown][] = [
      ['POST', '/api/tasks/start', { prompt: 'look around', cwd: '/etc' }],
      ['POST', '/api/tasks/start', { prompt: 'look around', worktree: true }],
      ['PATCH', '/api/tasks/demo1', { sandbox: false }],
      ['PATCH', '/api/tasks/demo1', { cwd: '/' }],
      ['POST', '/api/tasks/demo1/messages', { prompt: 'hi', attachments: [{ id: 'a' }] }],
      ['POST', '/api/tasks/demo1/permission-requests/demo1', { decision: 'always' }],
      ['POST', '/api/tasks/start', 'not json'],
    ]
    for (const [method, path, body] of cases) {
      expect(await refusedBody(await send(method, path, body)), `${method} ${path}`).toBe(DEMO_REFUSED_TITLE)
    }
  })

  it('lets allowed routes through to Seti, which still asks for a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/tasks'],
      ['POST', '/api/tasks/demo1/messages'],
    ] as const) {
      expect((await send(method, path, { prompt: 'hi' })).status, `${method} ${path}`).toBe(401)
    }
  })

  it('answers only the mod routes an enabled mod marked for the demo', async () => {
    expect(await refusedBody(await send('GET', '/api/mods/sample/hello'))).toBe(DEMO_REFUSED_TITLE)
    expect((await send('GET', '/api/mods/sample')).status).toBe(401)
    await modHost.setEnabled('sample', true)
    try {
      expect((await send('GET', '/api/mods/sample/hello')).status).toBe(401)
      expect(await refusedBody(await send('POST', '/api/mods/sample/count'))).toBe(DEMO_REFUSED_TITLE)
      expect(await refusedBody(await send('PATCH', '/api/mods/sample', { enabled: false }))).toBe(DEMO_REFUSED_TITLE)
    } finally {
      await modHost.setEnabled('sample', false)
    }
  })

  it('holds each visitor to 60 changes a minute, apart from the others', async () => {
    const guarded = new Hono()
      .use('*', demoGuard(new Map([['POST /write', {}]])))
      .post('/write', (c) => c.body(null, 204))
    const write = async (visitor: string) =>
      (await guarded.request('/write', { method: 'POST', headers: { 'x-forwarded-for': visitor } })).status
    for (let n = 0; n < 60; n += 1) {
      expect(await write('203.0.113.7')).toBe(204)
    }
    expect(await write('203.0.113.7')).toBe(429)
    expect(await write('198.51.100.9')).toBe(204)
  })

  it('answers PR preview hosts with nothing, so no request is proxied to the web', async () => {
    const res = await app.request('/', { headers: { host: 'storefront-pr-482.seti.localhost' } })
    expect(res.status).toBe(404)
  })

  it('marks the page shell as the demo with its reset time, and leaves other answers alone', async () => {
    const resetsAt = new Date('2026-10-29T12:00:00.000Z')
    const shell = new Hono()
      .use('*', demoShell(resetsAt))
      .get('/', (c) => {
        c.header('content-length', '45')
        return c.html('<html><head><title>Seti</title></head></html>')
      })
      .get('/data', (c) => c.json({ head: '<head>' }))
    const res = await shell.request('/')
    expect(res.headers.get('content-length'), 'the old length would cut the page short').toBeNull()
    const page = await res.text()
    expect(page).toContain(`<head><meta name="seti-demo" content="${resetsAt.toISOString()}" />`)
    expect(await (await shell.request('/data')).json()).toEqual({ head: '<head>' })
  })
})

/** How many middleware handlers each shared path holds; a new one must be reviewed for the demo. */
const MIDDLEWARE_COUNTS: Record<string, number> = {
  'ALL /*': 5,
  'ALL /api/*': 6,
  'ALL /api/auth/*': 1,
  'ALL /api/credentials/*': 1,
  'ALL /api/devices/*': 1,
  'ALL /api/permissions/*': 1,
  'ALL /api/sandbox/*': 1,
  'ALL /api/secrets/*': 1,
  'ALL /api/ssh/*': 1,
  'ALL /api/tasks/:id': 1,
  'ALL /api/tasks/:id/*': 1,
  'ALL /api/tasks/:id/files/*': 1,
}

describe('middleware on allowed paths', () => {
  it('is the set reviewed for the demo', () => {
    const counts: Record<string, number> = {}
    for (const route of inner.routes) {
      const key = routeKey(route.method, route.path)
      if (route.method === 'ALL' && DEMO_ALLOWLIST.has(key)) {
        counts[key] = (counts[key] ?? 0) + 1
      }
    }
    expect(counts).toEqual(MIDDLEWARE_COUNTS)
  })
})
