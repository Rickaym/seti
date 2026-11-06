import type { Context, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import type { z } from 'zod'
import { fail } from '../http.js'
import { clientAddress, clientNetwork, rateLimiter } from '../rate-limit.js'

/** A route as the Hono app registered it, such as `GET /api/tasks/:id`. */
export const routeKey = (method: string, path: string) => `${method} ${path}`

/** What the demo lets through on one route; a body schema allows only the fields it names. */
export interface DemoRoute {
  body?: z.ZodType
}

export type DemoAllowlist = ReadonlyMap<string, DemoRoute>

/** The route every mod route passes through; each mod says which of its routes the demo answers. */
const MOD_ROUTES = '/api/mods/:id/*'

/** Under a mod's prefix; the wildcard also matches `/api/mods/<id>`, which has its own route. */
const UNDER_A_MOD = /^\/api\/mods\/[^/]+\/./

/** Whether an enabled mod marked the route it answers at the method and path as one for the demo. */
export type DemoModRoutes = (method: string, path: string) => boolean

export const DEMO_REFUSED_TITLE = 'Not in the demo'

const refused = (c: Context, detail: string) => fail(c, 403, DEMO_REFUSED_TITLE, detail)

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Changes per visitor a minute, so no one can flood the shared demo or its database. */
const WRITES_PER_MINUTE = 60

/** The visitor's network as the proxy in front reports it; without one, every visitor shares one. */
function visitor(c: Context): string {
  const address = clientAddress(c)
  return address === null ? 'direct' : clientNetwork(address)
}

async function bodyRefusal(c: Context, rules: readonly DemoRoute[]): Promise<string | null> {
  const schemas = rules.flatMap((rule) => (rule.body === undefined ? [] : [rule.body]))
  if (schemas.length === 0 || !WRITES.has(c.req.method)) {
    return null
  }
  const body: unknown = await c.req.json().catch(() => null)
  const failed = schemas.find((schema) => !schema.safeParse(body).success)
  return failed === undefined ? null : 'The demo takes only some of the fields this request sends'
}

/**
 * Lets a request through only when every route it matches, middleware included, is on the
 * allowlist, so a route added later is refused until someone decides it is safe for the demo.
 */
export function demoGuard(allowlist: DemoAllowlist, modRoutes: DemoModRoutes = () => false): MiddlewareHandler {
  const writes = rateLimiter(WRITES_PER_MINUTE, 60_000)
  const ruleFor = (c: Context, route: { method: string; path: string }): DemoRoute | undefined => {
    if (route.path !== MOD_ROUTES) {
      return allowlist.get(routeKey(route.method, route.path))
    }
    if (!UNDER_A_MOD.test(c.req.path)) {
      return {}
    }
    return modRoutes(c.req.method, c.req.path) ? {} : undefined
  }
  const guard: MiddlewareHandler = async (c, next) => {
    const rules: DemoRoute[] = []
    for (const route of matchedRoutes(c).filter((matched) => matched.handler !== guard)) {
      const rule = ruleFor(c, route)
      if (rule === undefined) {
        return refused(c, 'The demo does not do this; install Seti to try it on your own machine')
      }
      rules.push(rule)
    }
    const why = await bodyRefusal(c, rules)
    if (why !== null) {
      return refused(c, why)
    }
    if (WRITES.has(c.req.method) && !writes.take(visitor(c))) {
      return fail(c, 429, 'Too many changes', 'The demo takes a minute to catch up; try again shortly')
    }
    await next()
    return undefined
  }
  return guard
}
