import type { SenderDefinition, SenderSource } from '@seti/shared'
import { redactSecrets } from '../scrub.js'
import { decodeJson } from './payload.js'
import { atPath, lazyJson, senderDigest, sourceText, textAtPath, verifySender } from './sender-verify.js'
import type { EventFields, Parsed, WebhookPresetAdapter } from './types.js'

const ECHO_MAX = 256
const TITLE_MAX = 200

const firstAt = (payload: unknown, paths: readonly string[]) =>
  paths.map((path) => textAtPath(payload, path)).find((text) => text !== '') ?? ''

const firstLine = (text: string) => text.split('\n', 1)[0]?.trim() ?? ''

const httpUrl = (text: string) => (URL.canParse(text) && /^https?:$/.test(new URL(text).protocol) ? text : null)

/** The event's name, with its action after a dot when the payload has one. */
function kindOf(definition: SenderDefinition, payload: unknown, headers: Headers): string {
  const name = definition.event === null ? '' : sourceText(definition.event, headers, () => payload)
  const action = definition.action === null ? '' : textAtPath(payload, definition.action)
  return [name, action].filter((part) => part !== '').join('.')
}

/** The text passed on: a detail field, else the payload itself, cut to the definition's cap. */
function detailOf(definition: SenderDefinition, payload: unknown): string {
  const text = firstAt(payload, definition.detail)
  const whole = text === '' ? redactSecrets(JSON.stringify(payload)) : text
  return whole.slice(0, definition.detail_max)
}

/** The update a verified delivery makes: its kind, title, link and capped text, as data says. */
export function readSenderEvent(
  definition: SenderDefinition,
  payload: unknown,
  headers: Headers,
  names: { sender: string; channel: string },
): EventFields {
  const kind = kindOf(definition, payload, headers)
  const title = firstLine(firstAt(payload, definition.title)).slice(0, TITLE_MAX)
  const fallback = kind === '' ? `Event from ${names.channel}` : `${names.sender} ${kind}`
  return {
    source: names.sender,
    severity: 'info',
    title: title === '' ? fallback : title,
    kind,
    detail: detailOf(definition, payload),
    url: httpUrl(firstAt(payload, definition.link)),
    occurred_at: new Date().toISOString(),
  }
}

/** Sets a dot path in a sample body, making the objects on the way. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = target
  for (const key of keys.slice(0, -1)) {
    const next: Record<string, unknown> = {}
    current[key] = next
    current = next
  }
  current[keys.at(-1) ?? path] = value
}

interface Sample {
  headers: Record<string, string>
  body: Record<string, unknown>
}

function put(sample: Sample, source: SenderSource | null, value: string | number): void {
  const { headers, body } = sample
  if (source?.in === 'header') {
    headers[source.name.toLowerCase()] = String(value)
  } else if (source !== null) {
    setPath(body, source.name, value)
  }
}

/** A delivery as the app would sign it, built from the definition for the Test button. */
function signedSample(definition: SenderDefinition, secret: string, nonce: string) {
  const sample: Sample = { headers: { 'content-type': 'application/json' }, body: {} }
  const seconds = Math.floor(Date.now() / 1000)
  for (const path of definition.title.slice(0, 1)) {
    setPath(sample.body, path, 'Test event from Seti')
  }
  put(sample, definition.event, 'test')
  put(sample, definition.id, nonce)
  if (definition.timestamp !== null && definition.timestamp.in !== 'signature') {
    put(sample, definition.timestamp, definition.timestamp.in === 'body' ? seconds * 1000 : seconds)
  }
  const body = JSON.stringify(sample.body)
  const { signature } = definition
  const header = signature.header.toLowerCase()
  if (signature.scheme === 'token') {
    return { headers: { ...sample.headers, [header]: `${signature.prefix}${secret}` }, body }
  }
  const digest = senderDigest(signature, secret, Buffer.from(body), { timestamp: String(seconds), id: nonce })
  const stamp = definition.timestamp?.in === 'signature' ? `${definition.timestamp.name}=${String(seconds)},` : ''
  return { headers: { ...sample.headers, [header]: `${stamp}${signature.prefix}${digest}` }, body }
}

/** The text a signed URL check asks for, or null when the payload is an ordinary delivery. */
function echoOf(definition: SenderDefinition, payload: unknown): string | null {
  const { handshake } = definition
  if (handshake === null) {
    return null
  }
  if (textAtPath(payload, handshake.path) !== handshake.equals) {
    return null
  }
  const echo = atPath(payload, handshake.echo)
  if (typeof echo !== 'string') {
    return null
  }
  return echo.length <= ECHO_MAX ? echo : null
}

/** How Seti verifies and reads a sender described as data: a catalog entry or the user's own. */
export function senderAdapter(sender: string, definition: SenderDefinition): WebhookPresetAdapter {
  return {
    verify: (request, secret, nowMs) => verifySender(definition, request, secret, nowMs),
    deliveryId: (request) =>
      definition.id === null ? null : sourceText(definition.id, request.headers, lazyJson(request.body)),
    decode: decodeJson,
    handshake: (payload) => echoOf(definition, payload),
    parse: (payload, headers, context): Parsed => ({
      kind: 'event',
      fields: readSenderEvent(definition, payload, headers, { sender, channel: context.channelName }),
    }),
    sample: (secret, nonce) => signedSample(definition, secret, nonce),
  }
}
