import { Registry, setiSubdomainOf } from '@seti/shared'
import type { MiddlewareHandler } from 'hono'
import { fail } from './http.js'
import { downstreamResponseHeaders, isTrustedSubdomainRequest, upstreamRequestHeaders, upstreamUrl } from './proxy.js'

/** A bundled mod's resolver for Seti subdomains, keyed `<mod>.<proxy>`. */
export interface HostProxyEntry {
  key: string
  /** The upstream origin for a canonical Seti subdomain, or null when the mod does not serve it. */
  resolve: (hostname: string) => Promise<URL | null>
}

export const hostProxies = new Registry<HostProxyEntry>('host proxy', (entry) => entry.key)

/** Responses the proxy relayed, which keep the upstream's own headers. */
const relayed = new WeakSet<Response>()

export const wasProxied = (res: Response): boolean => relayed.has(res)

async function targetOf(hostname: string): Promise<URL | null> {
  for (const entry of hostProxies.list()) {
    const target = await entry.resolve(hostname)
    if (target !== null) {
      return target
    }
  }
  return null
}

/**
 * Serves subdomains of Seti's host from the origin a mod's host proxy resolves; other hosts fall
 * through. A subdomain no proxy serves answers 404, so Seti's own pages never load there.
 */
export const subdomainProxy: MiddlewareHandler = async (c, next) => {
  const host = c.req.header('host') ?? ''
  const subdomain = setiSubdomainOf(host.replace(/:\d+$/, '').toLowerCase())
  if (subdomain === null) {
    await next()
    return undefined
  }
  const target = await targetOf(subdomain)
  if (target === null) {
    return fail(c, 404, 'Not found', 'Nothing serves this host')
  }
  const proxyOrigin = `http://${host}`
  if (!isTrustedSubdomainRequest(c.req.raw.headers, proxyOrigin)) {
    return c.text('Requests to this host must come from Seti or from the host itself.', 403)
  }
  const incoming = new URL(c.req.url)
  const url = upstreamUrl(`${incoming.pathname}${incoming.search}`, target)
  if (!url) {
    return c.text('Path does not belong to this host.', 400)
  }
  const method = c.req.method
  try {
    const res = await fetch(url, {
      method,
      headers: upstreamRequestHeaders(c.req.raw.headers, proxyOrigin, target),
      body: method === 'GET' || method === 'HEAD' ? null : c.req.raw.body,
      duplex: 'half',
      redirect: 'manual',
    })
    const response = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: downstreamResponseHeaders(res.headers, proxyOrigin, target),
    })
    relayed.add(response)
    return response
  } catch (e) {
    return c.text(`Upstream unreachable: ${e instanceof Error ? e.message : String(e)}`, 502)
  }
}
