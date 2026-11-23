import type { Context, Next } from 'hono'
import { routePath } from 'hono/route'
import { redactSecrets } from './scrub.js'
import { redactSharePath } from './share-path.js'

const MAX_MESSAGE = 300

/** The route pattern that answered, or the path when only a catch-all did; never the query. */
function routeOf(c: Context): string {
  const pattern = routePath(c)
  return pattern.endsWith('*') ? redactSharePath(c.req.path) : pattern
}

/** The error's name and the first line of its message with credentials redacted; no stack. */
function described(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'answered without a thrown error'
  }
  const line = error.message.split('\n', 1)[0] ?? ''
  return `${error.name}: ${redactSecrets(line).slice(0, MAX_MESSAGE)}`
}

/** Logs every 5xx answer by method, route, status and error; never a body, query or header. */
export async function logServerErrors(c: Context, next: Next): Promise<void> {
  await next()
  if (c.res.status >= 500) {
    process.stderr.write(`server error: ${c.req.method} ${routeOf(c)} ${String(c.res.status)} ${described(c.error)}\n`)
  }
}
