import type http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { answer, type Target } from './egress-answers.js'
import { planBody, PlaceholderInBody, TOO_LARGE, watchRest, type BodyPlan } from './egress-body.js'
import { withoutHopByHop } from './egress-hosts.js'
import type { EgressPlaceholder } from './egress-placeholders.js'

/** A request from the sandbox on its way to `host`, with its body planned. */
export interface Relayed {
  host: string
  req: IncomingMessage
  res: ServerResponse
  plan: BodyPlan
}

/**
 * How the request's body goes on, or null once it is answered: refused, reporting the connections
 * it carried toward the wrong place, or its client gone.
 */
export async function bodyOf(
  { target, req, res }: { target: Target; req: IncomingMessage; res: ServerResponse },
  entries: readonly EgressPlaceholder[],
  onBlocked?: (host: string, names: readonly string[]) => void,
): Promise<BodyPlan | null> {
  const plan = await planBody(target, req.headers, req, entries)
  if (plan !== null && 'status' in plan) {
    if (plan.names.length > 0) {
      onBlocked?.(target.host, plan.names)
    }
    answer(res, plan.status, plan.body)
    req.resume()
    return null
  }
  return plan
}

/** Sends the request's body as planned and relays the answer back to the sandbox. */
export function relay({ host, req, res, plan }: Relayed, out: http.ClientRequest): void {
  let refused = false
  out.on('response', (upstream) => {
    res.writeHead(upstream.statusCode ?? 502, withoutHopByHop(upstream.headers))
    upstream.pipe(res)
  })
  out.on('error', (e) => {
    if (!refused) {
      answer(res, 502, `Seti sandbox proxy could not reach ${host}: ${e.message}`)
    }
  })
  res.on('close', () => {
    if (!res.writableFinished) {
      out.destroy()
    }
  })
  if (plan.kind === 'stream') {
    req.pipe(out)
    return
  }
  if (plan.kind === 'whole') {
    out.end(plan.body)
    return
  }
  const watch = watchRest(plan.watch, plan.head)
  watch.on('error', (e) => {
    refused = true
    req.unpipe(watch)
    req.resume()
    answer(res, TOO_LARGE.status, e.message)
    out.destroy()
  })
  out.write(plan.head)
  req.pipe(watch).pipe(out)
}

/** The whole body for a request sent twice, or why it cannot be held: too large, or a placeholder. */
export async function heldBody(
  plan: BodyPlan,
  req: IncomingMessage,
  limit: number,
): Promise<Buffer | 'large' | PlaceholderInBody> {
  if (plan.kind === 'whole') {
    return plan.body
  }
  const head = plan.kind === 'rest' ? plan.head : Buffer.alloc(0)
  const rest = await readLimited(req, limit - head.length)
  if (rest === null) {
    return 'large'
  }
  const body = Buffer.concat([head, rest])
  const carries = plan.kind === 'rest' && plan.watch.some((needle) => body.includes(needle))
  return carries ? new PlaceholderInBody() : body
}

/** The whole body of a request, or null once it passes the limit. */
async function readLimited(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) {
      req.resume()
      return null
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
