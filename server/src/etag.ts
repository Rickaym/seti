import { hash } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

/** A JSON body built in memory; served files name their length or disposition. */
function hashable(res: Response): boolean {
  const headers = res.headers
  return (
    res.status === 200 &&
    res.body !== null &&
    (headers.get('content-type') ?? '').startsWith('application/json') &&
    !headers.has('etag') &&
    !headers.has('content-encoding') &&
    !headers.has('content-length') &&
    !headers.has('content-disposition')
  )
}

/** If-None-Match compares weakly, so a proxy that marks the tag weak still matches it. */
function matches(ifNoneMatch: string | undefined, tag: string): boolean {
  if (ifNoneMatch === undefined) {
    return false
  }
  return ifNoneMatch.split(',').some((candidate) => {
    const value = candidate.trim()
    return value === '*' || value.replace(/^W\//, '') === tag
  })
}

/** Strong ETags on JSON GETs, and 304 with no body when the client already holds that body. */
export const jsonEtag: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.req.method !== 'GET' || !hashable(c.res)) {
    return
  }
  const body = await c.res.text()
  const tag = `"${hash('sha1', body, 'base64url')}"`
  // eslint-disable-next-line no-param-reassign -- Hono swaps a finished response only through c.res
  c.res = matches(c.req.header('if-none-match'), tag)
    ? new Response(null, { status: 304, headers: { ETag: tag } })
    : new Response(body, {
        status: 200,
        headers: { ETag: tag, 'Content-Type': c.res.headers.get('content-type') ?? '' },
      })
}
