import type { ModCaller, ModRequest, ModStreamHandler } from '@seti/mod-api'
import { modActionInput, modActionParams, modChangeInput, modListInput, modParams } from '@seti/shared'
import { Hono, type Context } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { currentRequestSource } from '../access.js'
import { fail, HttpError, ok, valid, validJson } from '../http.js'
import { changeMod, listMods, modDetail, setModSafeMode } from '../mods/actions.js'
import { runModAction } from '../mods/commands.js'
import { findModRoute } from '../mods/points.js'
import { redactSecrets } from '../scrub.js'

const READS = new Set(['GET', 'HEAD'])

/** Who sent a request to a mod's route: the EA, an agent through its seti tools, or the user. */
function requestCaller(): ModCaller {
  const source = currentRequestSource()
  switch (source?.via) {
    case 'ea':
      return { source: 'ea', agent: null }
    case 'agent':
      return { source: 'agent', agent: source.taskId }
    case 'session':
    case 'local':
    case 'public':
    case 'device':
    case 'mod':
    case undefined:
      return { source: 'user', agent: null }
  }
}

const streamFailure = (e: unknown) =>
  e instanceof HttpError ? redactSecrets(e.message).slice(0, 300) : "The mod's stream failed"

/** A promise and its resolve, for a value that arrives later. */
function later<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const box: { resolve: ((value: T) => void) | null } = { resolve: null }
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve
  })
  return { promise, resolve: (value) => box.resolve?.(value) }
}

/**
 * Answers a streaming route: a throw before the first event is a refusal, as for any route; once
 * an event went out the response is server-sent events until the handler ends.
 */
async function streamed(c: Context, handle: ModStreamHandler, request: ModRequest): Promise<Response> {
  const gone = new AbortController()
  const opened = later<SSEStreamingApi>()
  const started = later<null>()
  const send = async (event: string, data: unknown) => {
    started.resolve(null)
    const stream = await opened.promise
    if (!gone.signal.aborted) {
      await stream.writeSSE({ event, data: JSON.stringify(data) })
    }
  }
  const work = handle(request, { send, signal: gone.signal })
  await Promise.race([work, started.promise])
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      gone.abort()
    })
    opened.resolve(stream)
    await work.catch(async (e: unknown) => {
      if (!gone.signal.aborted) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', error: streamFailure(e) }) })
      }
    })
  })
}

/** Hands a request under /api/mods/<id>/ to the route an enabled mod registered for it. */
async function dispatch(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? ''
  const rest = c.req.path.slice(`/api/mods/${id}`.length)
  const found = findModRoute(id, c.req.method === 'HEAD' ? 'GET' : c.req.method, rest)
  if (found === null) {
    return fail(c, 404, 'Not found')
  }
  const body: unknown = READS.has(c.req.method) ? null : await c.req.json().catch(() => null)
  const request = { params: found.params, query: c.req.query(), body, caller: requestCaller() }
  if (found.route.stream) {
    return streamed(c, found.route.handle, request)
  }
  const answer = await found.route.handle(request)
  if (answer.status === undefined || answer.status === 200) {
    return ok(c, answer.body)
  }
  const reason = typeof answer.body === 'string' ? answer.body : 'The mod refused the request'
  return fail(c, answer.status, 'Refused', reason)
}

/** Settings, Mods and the routes mods add; who may change what is decided in mods/actions.ts. */
export const modRoutes = new Hono()
  .get('/', async (c) => ok(c, await listMods()))
  .put('/', validJson(modListInput), async (c) => ok(c, await setModSafeMode(c.req.valid('json').safe_mode)))
  .get('/:id', valid('param', modParams), async (c) => ok(c, await modDetail(c.req.valid('param').id)))
  .patch('/:id', valid('param', modParams), validJson(modChangeInput), async (c) =>
    ok(c, await changeMod(c.req.valid('param').id, c.req.valid('json'))),
  )
  .post('/:id/actions/:action', valid('param', modActionParams), validJson(modActionInput), async (c) => {
    const { id, action } = c.req.valid('param')
    return ok(c, await runModAction(id, action, c.req.valid('json').args))
  })
  .all('/:id/*', valid('param', modParams), dispatch)
