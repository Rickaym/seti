import type { MiddlewareHandler } from 'hono'
import type { PublicAccess } from './config.js'
import { applyShareHeaders, shareOrigin, underShare } from './share-path.js'
import { wasProxied } from './subdomain-proxy.js'

const HSTS = 'max-age=31536000; includeSubDomains'

/** Audio worklets of the EA call load from blob URLs, so scripts allow blob: next to self. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

/** The microphone is for the EA call on Seti's own origin; the camera and the rest stay off. */
const PERMISSIONS_POLICY = 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()'

/** A route that sets its own policy, such as the HTML preview, keeps it. */
function keep(headers: Headers, name: string, value: string) {
  if (!headers.has(name)) {
    headers.set(name, value)
  }
}

/** Headers for every Seti response; a proxied response keeps the upstream's, /share gets its own. */
export function securityHeaders(access: PublicAccess | null): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host') ?? ''
    const hostname = host.replace(/:\d+$/, '').toLowerCase()
    await next()
    if (wasProxied(c.res)) {
      return
    }
    const headers = c.res.headers
    keep(headers, 'Content-Security-Policy', CSP)
    headers.set('X-Content-Type-Options', 'nosniff')
    keep(headers, 'X-Frame-Options', 'DENY')
    keep(headers, 'Referrer-Policy', 'strict-origin-when-cross-origin')
    headers.set('Permissions-Policy', PERMISSIONS_POLICY)
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    headers.set('Cross-Origin-Resource-Policy', 'same-origin')
    if (c.req.path.startsWith('/api/') && !headers.has('Cache-Control')) {
      headers.set('Cache-Control', 'no-store')
    }
    if (access !== null && hostname === access.hostname) {
      headers.set('Strict-Transport-Security', HSTS)
    }
    if (underShare(c.req.path)) {
      applyShareHeaders(headers, c.req.path, shareOrigin(host, access))
    }
  }
}
