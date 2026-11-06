import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addressProblem, createPollFetch, redactValues, type PollFetchConfig } from './fetch.js'

const SECRET = ['poller', 'test', 'secret', 'fetch'].join('-')

let server: http.Server
let other: http.Server
let port = 0
let otherPort = 0

async function listen(handler: http.RequestListener): Promise<[http.Server, number]> {
  const created = http.createServer(handler)
  return new Promise((resolve) => {
    created.listen(0, '127.0.0.1', () => {
      resolve([created, (created.address() as AddressInfo).port])
    })
  })
}

beforeAll(async () => {
  ;[other, otherPort] = await listen((req, res) => {
    res.end(JSON.stringify({ auth: req.headers.authorization ?? null }))
  })
  ;[server, port] = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'https://fake.test')
    if (url.pathname === '/echo') {
      res.setHeader('x-echo', req.headers.authorization ?? '')
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null, key: url.searchParams.get('key') }))
    } else if (url.pathname === '/big') {
      res.end('x'.repeat(2048))
    } else if (url.pathname === '/kb') {
      res.end('x'.repeat(900))
    } else if (url.pathname === '/same') {
      res.writeHead(302, { location: '/echo' }).end()
    } else if (url.pathname === '/away') {
      res.writeHead(302, { location: `http://other.test:${String(otherPort)}/` }).end()
    } else if (url.pathname === '/outside') {
      res.writeHead(302, { location: 'http://nope.test/' }).end()
    } else {
      res.end('ok')
    }
  })
})

afterAll(() => {
  server.close()
  other.close()
})

/* eslint-disable sonarjs/no-hardcoded-ip -- private, link-local and public addresses under test */
const ANSWERS: Record<string, { address: string; family: number }[]> = {
  'metadata.test': [{ address: '169.254.169.254', family: 4 }],
  'intranet.test': [
    { address: '93.184.216.34', family: 4 },
    { address: '10.1.2.3', family: 4 },
  ],
}

const lookup = async (host: string) => Promise.resolve(ANSWERS[host] ?? [{ address: '127.0.0.1', family: 4 }])

function config(overrides: Partial<PollFetchConfig> = {}): PollFetchConfig {
  return {
    allowed: [`127.0.0.1:${String(port)}`, `other.test:${String(otherPort)}`, 'metadata.test', 'intranet.test'],
    secrets: new Map([['api_token', SECRET]]),
    responseMaxBytes: 1024,
    runResponseMaxBytes: 2000,
    requestBodyMaxBytes: 1024,
    timeoutMs: 2000,
    allowLoopback: true,
    lookup,
    ...overrides,
  }
}

const signal = new AbortController().signal
const base = () => `http://127.0.0.1:${String(port)}`

describe('addressProblem', () => {
  it('refuses this machine, private networks, link-local and mapped forms of them', () => {
    for (const address of ['127.0.0.1', '10.0.0.8', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1']) {
      expect(addressProblem(address)).toMatch(/private or local/)
    }
    for (const address of ['::1', 'fe80::1', 'fd00::5', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::']) {
      expect(addressProblem(address)).toMatch(/private or local/)
    }
    expect(addressProblem('93.184.216.34')).toBeNull()
    expect(addressProblem('2606:4700::1111')).toBeNull()
  })

  it('lets development servers reach loopback only when asked', () => {
    expect(addressProblem('127.0.0.1', true)).toBeNull()
    expect(addressProblem('::1', true)).toBeNull()
    expect(addressProblem('10.0.0.1', true)).toMatch(/private/)
  })
})

/* eslint-enable sonarjs/no-hardcoded-ip -- the requests below go to local fakes */

describe('createPollFetch', () => {
  it('fills secret headers and query values, and redacts them from what comes back', async () => {
    const fetch = createPollFetch(config())
    const response = await fetch(
      {
        url: `${base()}/echo`,
        init: { secretHeaders: { Authorization: 'Bearer {{api_token}}' }, secretQuery: { key: '{{ api_token }}' } },
      },
      signal,
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ auth: 'Bearer [secret]', key: '[secret]' })
    expect(response.url).toBe(`${base()}/echo?key=[secret]`)
    expect(response.headers).toContainEqual(['x-echo', 'Bearer [secret]'])
    expect(JSON.stringify(response)).not.toContain(SECRET)
  })

  it('refuses secrets the poller was not given, and headers a script may not set', async () => {
    const fetch = createPollFetch(config())
    await expect(
      fetch({ url: `${base()}/echo`, init: { secretHeaders: { Authorization: '{{github_agent_token}}' } } }, signal),
    ).rejects.toThrow('The secret github_agent_token is not given to this poller')
    await expect(fetch({ url: `${base()}/echo`, init: { headers: { Host: 'evil.test' } } }, signal)).rejects.toThrow(
      'The header Host cannot be set',
    )
  })

  it('refuses hosts off the allowlist, private addresses and loopback unless allowed', async () => {
    const fetch = createPollFetch(config())
    await expect(fetch({ url: 'http://nope.test/', init: {} }, signal)).rejects.toThrow('not on the allowed hosts')
    await expect(fetch({ url: 'http://metadata.test/', init: {} }, signal)).rejects.toThrow(
      'metadata.test is refused: 169.254.169.254 is a private or local address',
    )
    await expect(fetch({ url: 'http://intranet.test/', init: {} }, signal)).rejects.toThrow('intranet.test is refused')
    await expect(fetch({ url: 'file:///etc/passwd', init: {} }, signal)).rejects.toThrow('Only http and https')
    await expect(fetch({ url: `http://u:p@127.0.0.1:${String(port)}/`, init: {} }, signal)).rejects.toThrow(
      'not in the URL',
    )
    const strict = createPollFetch(config({ allowLoopback: false }))
    await expect(strict({ url: `${base()}/`, init: {} }, signal)).rejects.toThrow('private or local')
  })

  it('stops reading a response over its size limit', async () => {
    const fetch = createPollFetch(config())
    await expect(fetch({ url: `${base()}/big`, init: {} }, signal)).rejects.toThrow('The response is over')
  })

  it('refuses responses past the total one run may read', async () => {
    const fetch = createPollFetch(config())
    await fetch({ url: `${base()}/kb`, init: {} }, signal)
    await fetch({ url: `${base()}/kb`, init: {} }, signal)
    await expect(fetch({ url: `${base()}/kb`, init: {} }, signal)).rejects.toThrow('The responses of one run are over')
  })

  it('follows redirects on the allowlist, and sends secrets to the first origin only', async () => {
    const fetch = createPollFetch(config())
    const secretHeaders = { Authorization: 'Bearer {{api_token}}' }
    const same = await fetch({ url: `${base()}/same`, init: { secretHeaders } }, signal)
    expect(JSON.parse(same.body)).toMatchObject({ auth: 'Bearer [secret]' })
    const away = await fetch({ url: `${base()}/away`, init: { secretHeaders } }, signal)
    expect(JSON.parse(away.body)).toEqual({ auth: null })
    await expect(fetch({ url: `${base()}/outside`, init: {} }, signal)).rejects.toThrow('nope.test is not on')
  })
})

describe('redactValues', () => {
  it('replaces every occurrence of every value', () => {
    expect(redactValues('a tok b tok', ['tok', ''])).toBe('a [secret] b [secret]')
  })
})
