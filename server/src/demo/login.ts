import { SETI_HOSTNAMES } from '@seti/shared'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { currentPublicHost, isSameOrigin } from '../access.js'
import { audit } from '../audit.js'
import { fail, ok } from '../http.js'
import { clientKey, rateLimiter } from '../rate-limit.js'
import { startSession } from '../seti-auth.js'
import { underShare } from '../share-path.js'
import { countSessions } from '../store/demo.js'

/** Where the sign-in page enters the demo; outside /api so Seti's own checks run before it. */
const DEMO_SESSION_PATH = '/demo/session'

const WINDOW_MS = 10 * 60_000
/** Demo entries per client per ten minutes. */
const perClient = rateLimiter(10, WINDOW_MS)
/** Live sessions the demo holds before it asks visitors to wait for the next reset. */
const SESSIONS_MAX = 2000

const hostnameOf = (c: Context) => (c.req.header('host') ?? '').replace(/:\d+$/, '').toLowerCase()

/** Seti's own page on its own host: the public hostname, or a loopback name. */
function sameSite(c: Context): boolean {
  const known = currentPublicHost() !== null || SETI_HOSTNAMES.has(hostnameOf(c))
  return known && isSameOrigin(c.req.header('origin') ?? '')
}

/** Signs a visitor in for the demo with a session no passkey started; it ends at the next reset. */
export function demoLoginRoutes(): Hono {
  return new Hono().post(DEMO_SESSION_PATH, async (c) => {
    if (!sameSite(c)) {
      return fail(c, 403, 'Forbidden', 'Enter the demo from its own page')
    }
    const publicHost = currentPublicHost()
    if (!perClient.take(clientKey(c, publicHost !== null))) {
      return fail(c, 429, 'Too many attempts', 'Wait a few minutes before entering the demo again')
    }
    if ((await countSessions()) >= SESSIONS_MAX) {
      return fail(c, 503, 'The demo is full', 'Try again after the next reset')
    }
    const host = publicHost?.hostname ?? hostnameOf(c)
    await startSession(c, { passkeyId: null, host, secure: publicHost !== null, ip: null })
    await audit.record({
      actor: 'user',
      kind: 'system.signin',
      subject_type: 'system',
      summary: `A visitor entered the demo on ${host}`,
      detail: { host, demo: true },
    })
    return ok(c, { signed_in: true })
  })
}

const META = 'seti-demo'

/** Tells the page it is the demo, and when the demo resets, through a meta tag in its shell. */
export function demoShell(resetsAt: Date): MiddlewareHandler {
  const tag = `<meta name="${META}" content="${resetsAt.toISOString()}" />`
  return async (ctx, next) => {
    await next()
    const html = ctx.res.headers.get('content-type')?.startsWith('text/html') === true
    if (!html || ctx.req.method !== 'GET' || underShare(ctx.req.path) || ctx.res.status !== 200) {
      return
    }
    const page = await ctx.res.text()
    const headers = new Headers(ctx.res.headers)
    headers.delete('content-length')
    headers.delete('etag')
    const status = ctx.res.status
    // Hono copies the old response's headers onto a new one, its stale length among them.
    ctx.res = undefined
    ctx.res = new Response(page.replace('<head>', `<head>${tag}`), { status, headers })
  }
}
