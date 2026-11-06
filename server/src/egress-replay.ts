import type http from 'node:http'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { withoutHopByHop } from './egress-hosts.js'
import type { Applied } from './egress-rules.js'

/** Everything a request with a renewable credential needs to go out again after a 401. */
export interface RenewingCall {
  host: string
  url: URL
  req: IncomingMessage
  res: ServerResponse
  headers: OutgoingHttpHeaders
  renewable: readonly Applied[]
  send: (headers: OutgoingHttpHeaders) => http.ClientRequest
  answer: (status: number, body: string) => void
}

const REPLAY_LIMIT = 32 * 1024 * 1024
const REPLAY_TEXT = '32 MiB'

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

/** Sends a buffered body and waits for the answer's head, or the error that stopped it. */
async function exchange(out: http.ClientRequest, body: Buffer): Promise<IncomingMessage | Error> {
  return new Promise((resolve) => {
    out.on('response', resolve)
    out.on('error', resolve)
    out.end(body)
  })
}

function pipeResponse(upstream: IncomingMessage, res: ServerResponse): void {
  res.writeHead(upstream.statusCode ?? 502, withoutHopByHop(upstream.headers))
  upstream.pipe(res)
}

/** The headers with each renewable credential minted afresh, or null when none changed. */
async function renewed(call: RenewingCall): Promise<OutgoingHttpHeaders | null> {
  const next: OutgoingHttpHeaders = { ...call.headers }
  let changed = false
  for (const { rule, value } of call.renewable) {
    const fresh = await rule.renew?.(call.url, value).catch(() => null)
    if (fresh !== null && fresh !== undefined && fresh !== value) {
      next[rule.header] = fresh
      changed = true
    }
  }
  return changed ? next : null
}

/**
 * Sends a request whose minted credential may be stale: the body is kept, and a 401 answer
 * gets one retry with freshly minted values before it reaches the sandbox.
 */
export async function relayRenewing(call: RenewingCall): Promise<void> {
  const body = await readLimited(call.req, REPLAY_LIMIT)
  if (body === null) {
    call.answer(413, `Seti sandbox proxy: bodies sent with a minted credential are limited to ${REPLAY_TEXT}`)
    return
  }
  const unreachable = (e: Error) => {
    call.answer(502, `Seti sandbox proxy could not reach ${call.host}: ${e.message}`)
  }
  const first = await exchange(call.send(call.headers), body)
  if (first instanceof Error) {
    unreachable(first)
    return
  }
  const retry = first.statusCode === 401 ? await renewed(call) : null
  if (retry === null) {
    pipeResponse(first, call.res)
    return
  }
  first.resume()
  const second = await exchange(call.send(retry), body)
  if (second instanceof Error) {
    unreachable(second)
    return
  }
  pipeResponse(second, call.res)
}
