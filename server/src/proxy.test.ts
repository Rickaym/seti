import { setiSubdomainOf } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import {
  downstreamResponseHeaders,
  rewriteLocation,
  rewriteSetCookie,
  stripCspDirectives,
  upstreamRequestHeaders,
} from './proxy.js'

const PROXY = 'http://dashboard-pr-2231.seti.localhost:3101'
const TARGET = new URL('https://pr-2231-staging.example.com')

describe('upstreamRequestHeaders', () => {
  it('points Host, Origin and Referer at the target', () => {
    const headers = upstreamRequestHeaders(
      new Headers({
        host: 'dashboard-pr-2231.seti.localhost:3101',
        origin: PROXY,
        referer: `${PROXY}/agents?tab=1`,
        cookie: 'sb=1',
        connection: 'keep-alive',
        'accept-encoding': 'gzip, br, zstd',
      }),
      PROXY,
      TARGET,
    )
    expect(Object.fromEntries(headers)).toEqual({
      host: 'pr-2231-staging.example.com',
      origin: 'https://pr-2231-staging.example.com',
      referer: 'https://pr-2231-staging.example.com/agents?tab=1',
      cookie: 'sb=1',
    })
  })

  it('drops a Referer from another origin such as the Seti page', () => {
    const headers = upstreamRequestHeaders(new Headers({ referer: 'http://localhost:3101/#prs' }), PROXY, TARGET)
    expect(headers.has('referer')).toBe(false)
    expect(headers.has('origin')).toBe(false)
  })
})

describe('stripCspDirectives', () => {
  it('removes frame-ancestors and upgrade-insecure-requests only', () => {
    const csp = "default-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests; report-uri /csp"
    expect(stripCspDirectives(csp)).toBe("default-src 'self'; report-uri /csp")
  })

  it('returns an empty policy when nothing else is left', () => {
    expect(stripCspDirectives("frame-ancestors 'none';")).toBe('')
  })
})

describe('rewriteLocation', () => {
  it('moves absolute target redirects onto the proxy origin', () => {
    expect(rewriteLocation('https://pr-2231-staging.example.com/login?next=%2F', PROXY, TARGET)).toBe(
      `${PROXY}/login?next=%2F`,
    )
  })

  it('leaves relative and foreign redirects alone', () => {
    expect(rewriteLocation('/login?next=%2F', PROXY, TARGET)).toBe('/login?next=%2F')
    expect(rewriteLocation('https://accounts.google.com/o/oauth2', PROXY, TARGET)).toBe(
      'https://accounts.google.com/o/oauth2',
    )
  })
})

describe('rewriteSetCookie', () => {
  it('strips Domain and makes the cookie usable inside the Seti iframe', () => {
    expect(rewriteSetCookie('sb-token=abc; Domain=.example.com; Path=/; HttpOnly; Secure; SameSite=Lax')).toBe(
      'sb-token=abc; Path=/; HttpOnly; SameSite=None; Secure',
    )
    expect(rewriteSetCookie('a=b; path=/; domain=example.com')).toBe('a=b; path=/; SameSite=None; Secure')
  })

  it('keeps cookie values that merely contain the word domain', () => {
    expect(rewriteSetCookie('domain=x; Path=/')).toBe('domain=x; Path=/; SameSite=None; Secure')
  })
})

describe('downstreamResponseHeaders', () => {
  it('allows framing and keeps the browser on the proxy', () => {
    const upstream = new Headers({
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'content-encoding': 'br',
      'content-length': '123',
      'content-type': 'text/html',
      location: 'https://pr-2231-staging.example.com/login',
    })
    upstream.append('set-cookie', 'a=1; Domain=example.com; Path=/')
    upstream.append('set-cookie', 'b=2; Path=/')
    const headers = downstreamResponseHeaders(upstream, PROXY, TARGET)
    expect(headers.get('x-frame-options')).toBeNull()
    expect(headers.get('content-encoding')).toBeNull()
    expect(headers.get('content-length')).toBeNull()
    expect(headers.get('content-security-policy')).toBe("default-src 'self'")
    expect(headers.get('content-type')).toBe('text/html')
    expect(headers.get('location')).toBe(`${PROXY}/login`)
    expect(headers.getSetCookie()).toEqual(['a=1; Path=/; SameSite=None; Secure', 'b=2; Path=/; SameSite=None; Secure'])
  })
})

describe('setiSubdomainOf', () => {
  it('keeps seti.localhost subdomains and maps the older preview.localhost ones', () => {
    expect(setiSubdomainOf('app-pr-7.seti.localhost')).toBe('app-pr-7.seti.localhost')
    expect(setiSubdomainOf('app-pr-7.preview.localhost')).toBe('app-pr-7.seti.localhost')
  })

  it('leaves Seti itself and other hosts alone', () => {
    for (const host of ['seti.localhost', 'localhost', '127.0.0.1', 'example.com']) {
      expect(setiSubdomainOf(host)).toBeNull()
    }
  })
})
