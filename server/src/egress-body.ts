import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import { Transform, type Readable, type TransformCallback } from 'node:stream'
import { hostMatches, reachesModelHost } from '@seti/shared'
import type { Target } from './egress-answers.js'
import { swapBody } from './egress-body-swap.js'
import { blockedText, placeholderAllowed, type EgressPlaceholder, type Refusal } from './egress-placeholders.js'

/** The most of a request body the proxy holds to look for a placeholder in it. */
export const BODY_LIMIT = 1024 * 1024
const LIMIT_TEXT = '1 MiB'

/** The body types the proxy reads for placeholders; it never reads any other. */
export type BodyType = 'json' | 'form' | 'multipart' | 'text'

export function bodyTypeOf(contentType: string | undefined): BodyType | null {
  const essence = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (essence === 'application/json' || (essence.startsWith('application/') && essence.endsWith('+json'))) {
    return 'json'
  }
  if (essence === 'application/x-www-form-urlencoded') {
    return 'form'
  }
  if (essence === 'multipart/form-data') {
    return 'multipart'
  }
  return essence === 'text/plain' ? 'text' : null
}

/** How the proxy sends a body on: streamed unread, whole once read, or read in part then watched. */
export type BodyPlan =
  { kind: 'stream' } | { kind: 'whole'; body: Buffer } | { kind: 'rest'; head: Buffer; watch: readonly Buffer[] }

/** A body the proxy refused, with the connections to report as blocked. */
export type BodyRefusal = Refusal & { names: readonly string[] }

const onHost = (entry: EgressPlaceholder, host: string) => entry.hosts.some((pattern) => hostMatches(pattern, host))

const identity = (headers: IncomingHttpHeaders) => {
  const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase()
  return encoding === '' || encoding === 'identity'
}

/** Up to `limit` bytes and whether that was all, or null when the client went away first. */
async function readUpTo(body: Readable, limit: number): Promise<{ head: Buffer; complete: boolean } | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (result: { head: Buffer; complete: boolean } | null) => {
      body.off('data', onData).off('end', onEnd)
      resolve(result)
    }
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(bytes)
      size += bytes.length
      if (size > limit) {
        body.pause()
        finish({ head: Buffer.concat(chunks), complete: false })
      }
    }
    const onEnd = () => {
      finish({ head: Buffer.concat(chunks), complete: true })
    }
    const onClose = () => {
      finish(null)
    }
    body.on('data', onData).once('end', onEnd).once('close', onClose).once('error', onClose)
  })
}

const offText = (host: string, names: readonly string[]) =>
  `Seti sandbox proxy: refused a request to ${host} carrying the placeholder of ${names.join(', ')} in its ` +
  'body, and sent nothing; retrying the same body will not help. Send the value in a header or the URL. ' +
  'If this site takes it only in the body, ask the user to turn on Body for that connection in Settings, ' +
  'Connections, or propose it with request_change (kind api_key, body true).'

const keyText = (host: string, names: readonly string[]) =>
  `Seti sandbox proxy: refused a request to ${host} carrying the placeholder of ${names.join(', ')} in its ` +
  "body, and sent nothing; retrying the same body will not help. That connection holds a model provider's " +
  'key, which goes in a header: send it there and leave it out of request bodies.'

const encodedText = (host: string) =>
  `Seti sandbox proxy: ${host} takes connection values in request bodies, which Seti cannot search ` +
  'once compressed. Send the body without a Content-Encoding.'

const tooLargeText = (names: readonly string[]) =>
  `Seti sandbox proxy: refused a request body over ${LIMIT_TEXT} carrying the placeholder of ${names.join(', ')}.`

export const TOO_LARGE: Omit<Refusal, 'body'> = { status: 413, reason: 'Payload Too Large' }

/** Whether the proxy reads the body: a text type, to one of the connections' hosts. */
const inspected = (target: Target, headers: IncomingHttpHeaders, entries: readonly EgressPlaceholder[]) =>
  bodyTypeOf(headers['content-type']) !== null && entries.some((entry) => onHost(entry, target.host))

/** An encoded body streams on unread, unless the host takes values in bodies: then it is refused. */
function encoded(target: Target, entries: readonly EgressPlaceholder[]): BodyPlan | BodyRefusal {
  const swaps = entries.some((entry) => entry.body && placeholderAllowed(entry, target.host, target.port))
  return swaps
    ? { status: 415, reason: 'Unsupported Media Type', body: encodedText(target.host), names: [] }
    : { kind: 'stream' }
}

/** A 403 naming the connections whose placeholders the body carried, never a value. */
function refused(
  text: (host: string, names: readonly string[]) => string,
  host: string,
  entries: readonly EgressPlaceholder[],
): BodyRefusal {
  const names = entries.map((entry) => entry.name)
  return { status: 403, reason: 'Forbidden', body: text(host, names), names }
}

/** A whole body to send with its connections' values swapped in, or why it is refused. */
async function checkWhole(
  target: Target,
  headers: IncomingHttpHeaders,
  body: Buffer,
  entries: readonly EgressPlaceholder[],
): Promise<BodyPlan | BodyRefusal> {
  const found = entries.filter((entry) => body.includes(entry.placeholder))
  if (found.length === 0) {
    return { kind: 'whole', body }
  }
  const blocked = found.filter((entry) => !placeholderAllowed(entry, target.host, target.port))
  if (blocked.length > 0) {
    return refused(blockedText, target.host, blocked)
  }
  const off = found.filter((entry) => !entry.body)
  if (off.length > 0) {
    return refused(off.some((entry) => reachesModelHost(entry.hosts)) ? keyText : offText, target.host, off)
  }
  const contentType = headers['content-type'] ?? ''
  const type = bodyTypeOf(contentType) ?? 'text'
  const swapped = await swapBody(body, { type, contentType }, found)
  return Buffer.isBuffer(swapped) ? { kind: 'whole', body: swapped } : { ...swapped, names: [] }
}

/**
 * How to send a request's body. The proxy reads only JSON, form, multipart and plain text bodies
 * without a content encoding, on its connections' hosts, holding at most BODY_LIMIT; any other
 * body streams on unread, except an encoded one where a connection swaps into bodies, which is
 * refused. Null when the client went away while it read.
 */
export async function planBody(
  target: Target,
  headers: IncomingHttpHeaders,
  body: Readable,
  entries: readonly EgressPlaceholder[],
): Promise<BodyPlan | BodyRefusal | null> {
  if (!inspected(target, headers, entries)) {
    return { kind: 'stream' }
  }
  if (!identity(headers)) {
    return encoded(target, entries)
  }
  const read = await readUpTo(body, BODY_LIMIT)
  if (read === null) {
    return null
  }
  if (read.complete) {
    return checkWhole(target, headers, read.head, entries)
  }
  const found = entries.filter((entry) => read.head.includes(entry.placeholder)).map((entry) => entry.name)
  if (found.length > 0) {
    return { ...TOO_LARGE, body: tooLargeText(found), names: found }
  }
  return { kind: 'rest', head: read.head, watch: entries.map((entry) => Buffer.from(entry.placeholder)) }
}

/** Raised by watchRest when a placeholder shows past the part the proxy held. */
export class PlaceholderInBody extends Error {
  constructor() {
    super(`Seti sandbox proxy: refused a request body over ${LIMIT_TEXT} carrying a connection placeholder.`)
  }
}

/** Passes the rest of a body on, failing as soon as a placeholder shows, across chunk edges too. */
export function watchRest(watch: readonly Buffer[], head: Buffer): Transform {
  const keep = Math.max(1, ...watch.map((needle) => needle.length)) - 1
  let tail = head.subarray(Math.max(0, head.length - keep))
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      const window = Buffer.concat([tail, chunk])
      if (watch.some((needle) => window.includes(needle))) {
        done(new PlaceholderInBody())
        return
      }
      tail = window.subarray(Math.max(0, window.length - keep))
      done(null, chunk)
    },
  })
}

/** The headers a body goes out with: a held body gets its exact length and no chunking. */
export function headersForBody(headers: OutgoingHttpHeaders, plan: BodyPlan): OutgoingHttpHeaders {
  if (plan.kind !== 'whole') {
    return headers
  }
  const out: OutgoingHttpHeaders = { ...headers, 'content-length': String(plan.body.length) }
  delete out['transfer-encoding']
  delete out.expect
  return out
}
