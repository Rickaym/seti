/* eslint-disable sonarjs/no-hardcoded-ip -- fake DNS answers and the private addresses mods never reach */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { callAs, probeManifest, valueOf } from './test-probe.js'
import { sql } from '../../db.js'
import { clearConnections, keyConnection } from '../../test-connections.js'

interface SeenRequest {
  host: string
  address: string
  path: string
  headers: Record<string, string>
}

interface Answer {
  status: number
  headers?: Record<string, string>
  body?: string
}

const upstream = vi.hoisted(() => {
  process.env.SETI_PUBLIC_URL = 'https://seti.example.net'
  return {
    seen: [] as SeenRequest[],
    routes: new Map<string, (request: SeenRequest) => Answer>(),
    addresses: new Map<string, string[]>(),
  }
})

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: async (host: string) =>
      Promise.resolve(
        (upstream.addresses.get(host) ?? ['93.184.216.34']).map((address) => ({
          address,
          family: address.includes(':') ? 6 : 4,
        })),
      ),
  },
}))

vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events')
  const request = (options: { host: string; path: string; headers: Record<string, string> }) => {
    const sent = Object.assign(new EventEmitter(), {
      destroy: (e?: Error) => {
        if (e !== undefined) {
          sent.emit('error', e)
        }
      },
      end: () => {
        queueMicrotask(() => {
          const seen = {
            host: options.headers.host ?? '',
            address: options.host,
            path: options.path,
            headers: options.headers,
          }
          upstream.seen.push(seen)
          const route = upstream.routes.get(`${seen.host}${seen.path}`)
          const answer: Answer = route === undefined ? { status: 404 } : route(seen)
          const response = Object.assign(new EventEmitter(), {
            statusCode: answer.status,
            headers: answer.headers ?? {},
            destroy: () => undefined,
          })
          sent.emit('response', response)
          if (answer.body !== undefined) {
            response.emit('data', Buffer.from(answer.body))
          }
          response.emit('end')
        })
      },
    })
    return sent
  }
  return { default: { request }, request }
})

const HOSTS = ['api.example.com', 'inner.example.com', 'rebind.example.com', 'seti.example.net', '*.wild.example.org']
const fetcher = probeManifest([{ name: 'net.fetch', hosts: HOSTS }])
const net = async (url: string, init: Record<string, unknown> = {}) => callAs(fetcher, 'net.fetch', { url, ...init })

const refusal = (message: string) => ({ ok: false, error: { code: 'denied', message } })

beforeEach(() => {
  upstream.seen.length = 0
  upstream.routes.clear()
  upstream.addresses.clear()
  upstream.addresses.set('rebind.example.com', ['10.0.0.5'])
  upstream.addresses.set('inner.example.com', ['192.168.1.1'])
  upstream.routes.set('api.example.com/ok', () => ({ status: 200, body: 'fine' }))
  upstream.routes.set('api.example.com/to-private', () => ({
    status: 302,
    headers: { location: 'https://inner.example.com/' },
  }))
  upstream.routes.set('api.example.com/to-evil', () => ({
    status: 302,
    headers: { location: 'https://evil.example.org/steal' },
  }))
  upstream.routes.set('api.example.com/to-http', () => ({
    status: 302,
    headers: { location: 'http://api.example.com:443/ok' },
  }))
  upstream.routes.set('a.wild.example.org/to-dotted', () => ({
    status: 302,
    headers: { location: 'https://seti.example.net./api/tasks' },
  }))
  upstream.routes.set('a.wild.example.org/to-seti', () => ({
    status: 302,
    headers: { location: 'https://seti.example.net/api/tasks' },
  }))
})

describe('net.fetch', () => {
  it('reaches a granted host on the address it checked', async () => {
    expect(valueOf(await net('https://api.example.com/ok'))).toMatchObject({ status: 200, body: 'fine' })
    expect(upstream.seen.map((seen) => seen.address)).toEqual(['93.184.216.34'])
  })

  it.each([
    ['http://api.example.com/ok', 'A mod fetches only https URLs, not http:'],
    ['https://127.0.0.1/', 'A mod names a host, never the address 127.0.0.1'],
    ['https://localhost/', 'localhost is Seti itself, which mods never reach'],
    ['https://[::1]/', 'A mod names a host, never the address ::1'],
    ['https://169.254.169.254/latest/meta-data', 'A mod names a host, never the address 169.254.169.254'],
    ['https://10.0.0.1/', 'A mod names a host, never the address 10.0.0.1'],
    ['https://[::ffff:127.0.0.1]/', 'A mod names a host, never the address ::ffff:7f00:1'],
    ['https://seti.example.net/api/tasks', 'seti.example.net is Seti itself, which mods never reach'],
    ['https://user:pw@api.example.com/ok', 'A mod puts credentials in a header, never in the URL'],
    ['https://api.example.com:8443/ok', 'A mod reaches api.example.com on port 443 only, not 8443'],
    ['https://other.example.com/', 'The mod probe was not granted net.fetch for other.example.com'],
    ['https://rebind.example.com/', 'rebind.example.com is refused: 10.0.0.5 is a private or local address'],
    ['https://api.example.com/to-private', 'inner.example.com is refused: 192.168.1.1 is a private or local address'],
    ['https://api.example.com/to-evil', 'evil.example.org is not in the hosts the mod probe was granted'],
    ['https://a.wild.example.org/to-seti', 'seti.example.net is Seti itself, which mods never reach'],
    ['https://api.example.com/to-http', 'api.example.com:443 is refused: only https URLs are fetched here'],
    ['https://a.wild.example.org/to-dotted', 'seti.example.net. is Seti itself, which mods never reach'],
  ])('refuses %s', async (url, message) => {
    expect(await net(url)).toEqual(refusal(message))
    expect(upstream.seen.every((seen) => seen.address === '93.184.216.34')).toBe(true)
  })

  it.each([
    [{ Host: 'evil.example.org' }, 'Host'],
    [{ 'Proxy-Authorization': 'Basic x' }, 'Proxy-Authorization'],
    [{ 'Transfer-Encoding': 'chunked' }, 'Transfer-Encoding'],
    [{ 'x-split': 'a\r\nInjected: 1' }, 'x-split'],
  ])('refuses the header %s', async (headers, name) => {
    expect(await net('https://api.example.com/ok', { headers })).toEqual(refusal(`The header ${name} cannot be set`))
    expect(upstream.seen).toEqual([])
  })

  it('takes no secret fields, which only a connection fills', async () => {
    const result = await net('https://api.example.com/ok', { secretHeaders: { authorization: '{{x}}' } })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } })
  })
})

const SECRET = 'sk-modtest-0123456789abcdef'

describe('connection.fetch', async () => {
  await clearConnections()
  const bearer = await keyConnection('sink_token', SECRET, {
    hosts: ['api.example.com'],
    header: { name: 'Authorization', template: 'Bearer {{value}}' },
  })
  const plain = await keyConnection('plain_key', 'plain-value-123456', { hosts: ['api.example.com'] })
  const capability = (variable: string) => ({
    name: 'connection',
    variable,
    hosts: ['api.example.com', 'only-grant.example.com'],
  })
  const sink = probeManifest([capability(bearer.env)])
  const viaSink = async (url: string, init: Record<string, unknown> = {}, connectionId: string | null = bearer.id) =>
    callAs(sink, 'connection.fetch', { url, connection: bearer.env, ...init }, { connectionId })
  const results: unknown[] = []

  afterAll(async () => {
    const rows = await sql<{ text: string }[]>`SELECT concat(summary, detail::text) AS text FROM audit_event`
    expect(JSON.stringify(results)).not.toContain(SECRET)
    expect(rows.map((row) => row.text).join('\n')).not.toContain(SECRET)
  })

  it('adds the key in Seti and redacts every echo of it', async () => {
    upstream.routes.set('api.example.com/echo', (seen) => ({
      status: 302,
      headers: { location: `https://api.example.com/echoed?k=${seen.headers.authorization ?? ''}` },
    }))
    upstream.routes.set(`api.example.com/echoed?k=Bearer%20${SECRET}`, (seen) => ({
      status: 200,
      headers: { 'x-echo': seen.headers.authorization ?? 'none' },
      body: JSON.stringify(seen.headers),
    }))
    upstream.routes.set(`api.example.com/echoed?k=Bearer ${SECRET}`, (seen) => ({
      status: 200,
      headers: { 'x-echo': seen.headers.authorization ?? 'none' },
      body: JSON.stringify(seen.headers),
    }))
    const result = await viaSink('https://api.example.com/echo', { headers: { Authorization: 'Bearer mine' } })
    results.push(result)
    expect(upstream.seen[0]?.headers.authorization).toBe(`Bearer ${SECRET}`)
    const value = valueOf(result) as { status: number; url: string; headers: [string, string][]; body: string }
    expect(value.status).toBe(200)
    expect(value.body).toContain('[secret]')
    expect(value.url).toContain('[secret]')
    expect(value.headers).toContainEqual(['x-echo', '[secret]'])
    expect(JSON.stringify(value)).not.toContain(SECRET)
    expect(JSON.stringify(value)).not.toContain('mine')
  })

  it('refuses a host outside the grant, and one the connection does not cover', async () => {
    results.push(await viaSink('https://evil.example.org/'))
    expect(results.at(-1)).toEqual(refusal('The mod probe was not granted connection for evil.example.org'))
    results.push(await viaSink('https://only-grant.example.com/'))
    expect(results.at(-1)).toEqual(refusal('only-grant.example.com is not a host of the SINK_TOKEN connection'))
    const [blocked] = await sql<{ actor: string }[]>`SELECT actor FROM audit_event WHERE kind = 'mod.api_key_blocked'`
    expect(blocked?.actor).toBe('mod:probe')
    expect(upstream.seen).toEqual([])
  })

  it('refuses a variable it was not granted, a gone connection and one without a header', async () => {
    results.push(await callAs(sink, 'connection.fetch', { url: 'https://api.example.com/ok', connection: 'OTHER' }))
    expect(results.at(-1)).toEqual(refusal('The mod probe was not granted the connection OTHER'))
    results.push(await viaSink('https://api.example.com/ok', {}, 'no-such-connection'))
    expect(results.at(-1)).toEqual(
      refusal('The SINK_TOKEN connection is gone; the user binds another in Settings, Mods'),
    )
    const keyed = probeManifest([capability(plain.env)])
    results.push(
      await callAs(
        keyed,
        'connection.fetch',
        { url: 'https://api.example.com/ok', connection: plain.env },
        {
          connectionId: plain.id,
        },
      ),
    )
    expect(results.at(-1)).toEqual(
      refusal(`The ${plain.env} connection sends its key in the body or URL, which mods cannot use`),
    )
    expect(upstream.seen).toEqual([])
  })

  it('sends the key to the first origin only, never across a redirect', async () => {
    upstream.routes.set('api.example.com/hop', () => ({
      status: 302,
      headers: { location: 'https://api.example.com/ok' },
    }))
    results.push(await viaSink('https://api.example.com/hop'))
    expect(upstream.seen.map((seen) => seen.headers.authorization)).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`])
    upstream.seen.length = 0
    const wide = probeManifest([{ ...capability(bearer.env), hosts: ['api.example.com', '*.wild.example.org'] }])
    upstream.routes.set('api.example.com/away', () => ({
      status: 302,
      headers: { location: 'https://a.wild.example.org/ok' },
    }))
    results.push(
      await callAs(
        wide,
        'connection.fetch',
        { url: 'https://api.example.com/away', connection: bearer.env },
        {
          connectionId: bearer.id,
        },
      ),
    )
    expect(results.at(-1)).toEqual(refusal('a.wild.example.org is not in the hosts the mod probe was granted'))
  })
})
/* eslint-enable sonarjs/no-hardcoded-ip -- only the fixtures above need it */
