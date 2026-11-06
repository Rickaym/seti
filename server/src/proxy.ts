import { SETI_HOSTNAMES } from '@seti/shared'

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

const DROPPED_RESPONSE = new Set([...HOP_BY_HOP, 'x-frame-options', 'content-encoding', 'content-length', 'set-cookie'])
const CSP_HEADERS = new Set(['content-security-policy', 'content-security-policy-report-only'])

function swapOrigin(value: string, from: string, to: string): string | null {
  if (!URL.canParse(value)) {
    return null
  }
  const url = new URL(value)
  return url.origin === from ? `${to}${url.pathname}${url.search}${url.hash}` : null
}

/** Headers for the upstream request: Host, Origin and Referer point at the upstream, not at Seti. */
export function upstreamRequestHeaders(incoming: Headers, proxyOrigin: string, target: URL): Headers {
  const headers = new Headers(incoming)
  for (const name of [...HOP_BY_HOP, 'accept-encoding']) {
    headers.delete(name)
  }
  headers.set('host', target.host)
  if (headers.has('origin')) {
    headers.set('origin', target.origin)
  }
  const referer = headers.get('referer')
  if (referer !== null) {
    const rewritten = swapOrigin(referer, proxyOrigin, target.origin)
    if (rewritten === null) {
      headers.delete('referer')
    } else {
      headers.set('referer', rewritten)
    }
  }
  return headers
}

/** The proxy serves plain http, so an upgrade-insecure-requests directive would break it. */
const STRIPPED_CSP = new Set(['frame-ancestors', 'upgrade-insecure-requests'])

export function stripCspDirectives(policy: string): string {
  return policy
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !STRIPPED_CSP.has(part.split(/\s+/)[0]?.toLowerCase() ?? ''))
    .join('; ')
}

export const rewriteLocation = (location: string, proxyOrigin: string, target: URL) =>
  swapOrigin(location, target.origin, proxyOrigin) ?? location

const REWRITTEN_COOKIE_ATTRIBUTES = new Set(['domain', 'samesite', 'secure'])

/** Host-only and SameSite=None, since the Seti page that opened the subdomain is another site. */
export function rewriteSetCookie(cookie: string): string {
  const [pair = '', ...attributes] = cookie.split(';')
  const kept = attributes.filter(
    (part) => !REWRITTEN_COOKIE_ATTRIBUTES.has(part.split('=')[0]?.trim().toLowerCase() ?? ''),
  )
  return [pair, ...kept, ' SameSite=None', ' Secure'].join(';')
}

/** Browser-facing headers: framing allowed, redirects and cookies kept on the proxy. */
export function downstreamResponseHeaders(upstream: Headers, proxyOrigin: string, target: URL): Headers {
  const headers = new Headers()
  for (const [name, value] of upstream) {
    if (DROPPED_RESPONSE.has(name)) {
      continue
    }
    if (CSP_HEADERS.has(name)) {
      const policy = stripCspDirectives(value)
      if (policy !== '') {
        headers.append(name, policy)
      }
      continue
    }
    headers.append(name, name === 'location' ? rewriteLocation(value, proxyOrigin, target) : value)
  }
  for (const cookie of upstream.getSetCookie()) {
    headers.append('set-cookie', rewriteSetCookie(cookie))
  }
  return headers
}

/** The upstream URL on the target origin, or null when the path would resolve to another host. */
export function upstreamUrl(pathAndQuery: string, target: URL): URL | null {
  const url = new URL(`${target.origin}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`)
  return url.origin === target.origin ? url : null
}

/** Same-origin, direct navigation or a Seti page; other sites cannot ride the subdomain's cookies. */
export function isTrustedSubdomainRequest(headers: Headers, proxyOrigin: string): boolean {
  const site = headers.get('sec-fetch-site')
  if (site === 'same-origin' || site === 'none') {
    return true
  }
  const referer = headers.get('referer')
  if (referer !== null && URL.canParse(referer)) {
    const from = new URL(referer)
    return from.origin === proxyOrigin || SETI_HOSTNAMES.has(from.hostname)
  }
  return site === null
}
