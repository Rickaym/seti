import fs from 'node:fs'
import http, { type OutgoingHttpHeaders } from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BODY_LIMIT } from './egress-body.js'
import type { EgressPlaceholder } from './egress-placeholders.js'
import { startEgressProxy, type EgressProxy } from './egress-proxy.js'
import type { EgressRule } from './egress-rules.js'
import { loadSandboxCa, type SandboxCa } from './sandbox-ca.js'

const VALUE = ['pw', 'fake', 'Lk4'].join('-')
const HOLDER = `seti-secret-site_login-${'e5'.repeat(16)}`
const LOGIN_HOST = 'app.login.test'
const MINTED_HOST = 'minted.login.test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-egress-body-'))
let ca: SandboxCa
let caPem: string
let standIn: https.Server
let standInPort = 0
let proxies = 0

/** What the stand-in login endpoint got: every request it saw start, and the bodies it read whole. */
const got = { started: 0, bodies: [] as { path: string; body: string; length: string | undefined }[] }

const entry: EgressPlaceholder = {
  name: 'site_login',
  placeholder: HOLDER,
  hosts: [LOGIN_HOST, MINTED_HOST],
  value: async () => Promise.resolve(VALUE),
}

beforeAll(async () => {
  ca = await loadSandboxCa(path.join(dir, 'ca'))
  await ca.cover(['login.test'])
  caPem = fs.readFileSync(path.join(ca.publicDir, 'ca.pem'), 'utf8')
  const context = await ca.contextFor(LOGIN_HOST)
  const minted = await ca.contextFor(MINTED_HOST)
  standIn = https.createServer({
    SNICallback: (name, done) => {
      done(null, name === LOGIN_HOST ? context : minted)
    },
  })
  standIn.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    got.started++
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      got.bodies.push({ path: req.url ?? '', body, length: req.headers['content-length'] })
      const status = req.url === '/strict' && req.headers.authorization !== 'Bearer fresh' ? 401 : 200
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: status === 200, bytes: Buffer.byteLength(body) }))
    })
  })
  await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve))
  standInPort = (standIn.address() as AddressInfo).port
})

afterAll(() => {
  standIn.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  got.started = 0
  got.bodies = []
})

const blocked: { host: string; names: readonly string[] }[] = []
const none = async () => Promise.resolve(null)

async function proxy(rules: readonly EgressRule[] = []): Promise<EgressProxy> {
  return startEgressProxy({
    socketPath: path.join(dir, `proxy-${String(++proxies)}.sock`),
    allowed: async () => Promise.resolve([]),
    ca,
    credentials: { claude: none, github: none, connector: none },
    rules: () => rules,
    placeholders: () => [entry],
    onBlocked: (host, names) => blocked.push({ host, names }),
    upstream: { address: async () => Promise.resolve({ host: '127.0.0.1', port: standInPort }), tls: { ca: caPem } },
  })
}

/** A POST through the proxy's interception of `host`, its body written in these pieces. */
async function post(
  running: EgressProxy,
  request: { host?: string; path?: string; headers: OutgoingHttpHeaders },
  ...pieces: (string | Buffer)[]
): Promise<{ status: number; body: string }> {
  const host = request.host ?? LOGIN_HOST
  const socket = await new Promise<Duplex>((resolve, reject) => {
    const req = http.request({ socketPath: running.socketPath, method: 'CONNECT', path: `${host}:443` })
    req.on('connect', (_res, tunnel) => {
      resolve(tunnel)
    })
    req.on('error', reject)
    req.end()
  })
  const secure = tls.connect({ socket, servername: host, ca: caPem })
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path: request.path ?? '/login',
        method: 'POST',
        headers: request.headers,
        createConnection: () => secure,
      },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => (text += chunk.toString()))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: text })
        })
      },
    )
    req.on('error', (e) => {
      resolve({ status: 0, body: e.message })
    })
    for (const piece of pieces) {
      req.write(piece)
    }
    req.end()
    secure.on('error', reject)
  })
}

const json = { 'content-type': 'application/json' }
const login = (password: string) => JSON.stringify({ email: 'qa@example.test', password })

describe('request bodies through the egress proxy', () => {
  it('refuses a login that carries the placeholder in its body; the stand-in receives nothing', async () => {
    const running = await proxy()
    blocked.length = 0
    const answer = await post(running, { headers: json }, login(HOLDER))
    expect(answer.status).toBe(403)
    expect(answer.body).toContain('site_login')
    expect(answer.body).not.toContain(VALUE)
    expect(got.started).toBe(0)
    expect(blocked).toEqual([{ host: LOGIN_HOST, names: ['site_login'] }])
    await running.close()
  })

  it('sends a body without a placeholder whole, with its exact length, even when chunked', async () => {
    const running = await proxy()
    const body = login('typed-by-the-agent')
    const answer = await post(running, { headers: json }, body.slice(0, 9), body.slice(9))
    expect(answer.status).toBe(200)
    expect(got.bodies).toEqual([{ path: '/login', body, length: String(Buffer.byteLength(body)) }])
    await running.close()
  })

  it('streams a body over the limit on, and cuts it off when a placeholder shows past the limit', async () => {
    const running = await proxy()
    const big = Buffer.alloc(BODY_LIMIT + 4096, 'a')
    const passed = await post(running, { headers: { 'content-type': 'text/plain' } }, big, 'end')
    expect(passed.status).toBe(200)
    expect(got.bodies[0]?.body.length).toBe(big.length + 3)
    got.bodies = []
    const cut = await post(running, { headers: { 'content-type': 'text/plain' } }, big, HOLDER)
    expect(cut.status).toBe(413)
    expect(cut.body).not.toContain(VALUE)
    expect(got.bodies).toEqual([])
    await running.close()
  })

  it('sends a non-text body on unread', async () => {
    const running = await proxy()
    const answer = await post(running, { headers: { 'content-type': 'application/octet-stream' } }, HOLDER)
    expect(answer.status).toBe(200)
    expect(got.bodies[0]?.body).toBe(HOLDER)
    await running.close()
  })

  it('replays a held body after a 401 renews the minted credential', async () => {
    const rule: EgressRule = {
      hosts: [MINTED_HOST],
      port: 443,
      header: 'authorization',
      value: async () => Promise.resolve('Bearer stale'),
      renew: async () => Promise.resolve('Bearer fresh'),
    }
    const running = await proxy([rule])
    const body = login('typed-by-the-agent')
    const answer = await post(running, { host: MINTED_HOST, path: '/strict', headers: json }, body)
    expect(answer.status).toBe(200)
    expect(got.bodies.map((seen) => seen.body)).toEqual([body, body])
    await running.close()
  })
})
