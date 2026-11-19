import { createHmac } from 'node:crypto'
import {
  isRecord,
  timeOf,
  type SenderDefinition,
  type SenderSigned,
  type SenderSignature,
  type SenderSource,
  type SenderTimestampSource,
} from '@seti/shared'
import { safeEqual } from './signature.js'
import type { Verdict, WebhookRequest } from './types.js'

type Hmac = Extract<SenderSignature, { scheme: 'hmac' }>

const SPLIT = { comma: ',', space: ' ' } as const
const KEY_PREFIX = /^(v1,)?whsec_/

/** The value a dot path names in a JSON body; a number picks an array entry. */
export function atPath(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      current = current[Number(key)]
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key]
    } else {
      return undefined
    }
  }
  return current
}

/** A string, number or boolean at a dot path as trimmed text; empty for anything else. */
export function textAtPath(value: unknown, path: string): string {
  const found = atPath(value, path)
  if (typeof found === 'string') {
    return found.trim()
  }
  return typeof found === 'number' || typeof found === 'boolean' ? String(found) : ''
}

/** The body as JSON, parsed at most once and only when a value is read from it. */
export function lazyJson(body: Buffer): () => unknown {
  let parsed: { value: unknown } | null = null
  return () => {
    if (parsed === null) {
      try {
        parsed = { value: JSON.parse(body.toString('utf8')) as unknown }
      } catch {
        parsed = { value: undefined }
      }
    }
    return parsed.value
  }
}

/** A header's or a body field's text; empty when the delivery has none. */
export const sourceText = (source: SenderSource, headers: Headers, json: () => unknown): string =>
  source.in === 'header' ? (headers.get(source.name)?.trim() ?? '') : textAtPath(json(), source.name)

/** The entries of a signature header: one, or a comma or space separated list. */
function entries(header: string, signature: Hmac): string[] {
  if (signature.separator === 'none') {
    return [header]
  }
  return header
    .split(SPLIT[signature.separator])
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

const startsWith = (text: string, prefix: string) => text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()

function timestampText(source: SenderTimestampSource, request: WebhookRequest, json: () => unknown, parts: string[]) {
  if (source.in !== 'signature') {
    return sourceText(source, request.headers, json)
  }
  const part = parts.find((entry) => startsWith(entry, `${source.name}=`))
  return part === undefined ? '' : part.slice(source.name.length + 1).trim()
}

const keyOf = (signature: Hmac, secret: string): Buffer | string =>
  signature.key === 'base64' ? Buffer.from(secret.replace(KEY_PREFIX, ''), 'base64') : secret

const LEAD: Record<SenderSigned, (timestamp: string, id: string) => string> = {
  '{body}': () => '',
  '{timestamp}.{body}': (timestamp) => `${timestamp}.`,
  'v0:{timestamp}:{body}': (timestamp) => `v0:${timestamp}:`,
  '{id}.{timestamp}.{body}': (timestamp, id) => `${id}.${timestamp}.`,
}

/** The signature a sender computes for these bytes, as the header holds it after the prefix. */
export function senderDigest(signature: Hmac, secret: string, body: Buffer, parts: { timestamp: string; id: string }) {
  const signed = Buffer.concat([Buffer.from(LEAD[signature.signed](parts.timestamp, parts.id)), body])
  return createHmac(signature.algorithm, keyOf(signature, secret)).update(signed).digest(signature.encoding)
}

const refused = (reason: string): Verdict => ({ ok: false, reason })

/** How old a timestamp may be; a clock a little ahead of Seti's is as fine as one behind. */
function ageVerdict(text: string, maxAgeS: number, nowMs: number): Verdict {
  const sent = timeOf(text)
  if (sent === null) {
    return refused(text === '' ? 'missing timestamp' : 'unreadable timestamp')
  }
  const ageS = Math.round((nowMs - Date.parse(sent)) / 1000)
  if (ageS > maxAgeS) {
    return refused(`too old: sent ${String(ageS)} s ago, over the ${String(maxAgeS)} s limit`)
  }
  return ageS < -maxAgeS ? refused(`timestamp is ${String(-ageS)} s in the future`) : { ok: true }
}

function verifyToken(header: string, prefix: string, secret: string): Verdict {
  if (!startsWith(header, prefix)) {
    return refused('token mismatch')
  }
  return safeEqual(header.slice(prefix.length).trim(), secret) ? { ok: true } : refused('token mismatch')
}

interface Checked {
  verdict: Verdict
  /** Whether the signature itself matched, whatever the timestamp says. */
  signed: boolean
}

/** Checks a delivery's signature, then its age; `signed` tells a stale delivery from a forged one. */
export function checkSender(definition: SenderDefinition, request: WebhookRequest, secret: string, nowMs: number) {
  const { signature } = definition
  const header = request.headers.get(signature.header)?.trim() ?? ''
  if (header === '') {
    return { verdict: refused('missing signature'), signed: false } satisfies Checked
  }
  if (signature.scheme === 'token') {
    const verdict = verifyToken(header, signature.prefix, secret)
    return { verdict, signed: verdict.ok } satisfies Checked
  }
  const json = lazyJson(request.body)
  const parts = entries(header, signature)
  const given = parts
    .filter((entry) => startsWith(entry, signature.prefix))
    .map((entry) => entry.slice(signature.prefix.length))
  const timestamp = definition.timestamp === null ? '' : timestampText(definition.timestamp, request, json, parts)
  const id = definition.id === null ? '' : sourceText(definition.id, request.headers, json)
  if (signature.signed.includes('{timestamp}') && timestamp === '') {
    return { verdict: refused('missing timestamp'), signed: false } satisfies Checked
  }
  if (signature.signed.includes('{id}') && id === '') {
    return { verdict: refused('missing delivery id'), signed: false } satisfies Checked
  }
  const expected = senderDigest(signature, secret, request.body, { timestamp, id })
  const normal = (text: string) => (signature.encoding === 'hex' ? text.trim().toLowerCase() : text.trim())
  const matches = given.map((entry) => safeEqual(normal(entry), expected)).includes(true)
  if (!matches) {
    return {
      verdict: refused(given.length === 0 ? 'missing signature' : 'signature mismatch'),
      signed: false,
    } satisfies Checked
  }
  const verdict =
    definition.timestamp === null ? { ok: true as const } : ageVerdict(timestamp, definition.max_age_s, nowMs)
  return { verdict, signed: true } satisfies Checked
}

/** A delivery verifies when its signature matches the raw body and its timestamp is fresh. */
export const verifySender = (
  definition: SenderDefinition,
  request: WebhookRequest,
  secret: string,
  nowMs: number,
): Verdict => checkSender(definition, request, secret, nowMs).verdict
