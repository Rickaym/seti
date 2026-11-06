import {
  isRecord,
  recordAt,
  textAt,
  timeOf,
  type ChannelState,
  type EaNoticeSeverity,
  type JsonRecord,
  type WebhookMapping,
  type WebhookMappingField,
} from '@seti/shared'
import { atPointer, decodeJson, firstLine, severityOf, stateOf } from './payload.js'
import { hmacHex, safeEqual, verifyHmac } from './signature.js'
import type { ParseContext, Parsed, WebhookPresetAdapter } from './types.js'

const SETI_SIGNATURE = 'x-seti-signature'
const SETI_DELIVERY = 'x-seti-delivery'
const BEARER = /^bearer\s/i

const KEYS = {
  title: ['title', 'summary', 'subject', 'name', 'alertname', 'message', 'text'],
  kind: ['kind', 'event_type', 'type', 'event', 'action'],
  detail: ['message', 'text', 'description', 'detail', 'details', 'body'],
  severity: ['severity', 'level', 'priority', 'status'],
  state: ['state', 'status'],
  subject: ['subject', 'monitor', 'check', 'service', 'host', 'alertname', 'name'],
  url: ['url', 'link', 'href', 'html_url', 'web_url', 'permalink', 'externalURL', 'generatorURL'],
  source: ['source', 'app', 'application'],
  time: ['occurred_at', 'timestamp', 'time', 'created_at', 'date', 'startsAt'],
} as const

/** Where common fields live: the root, then the usual envelopes and the first alert of a group. */
function scopesOf(payload: unknown): JsonRecord[] {
  const root = isRecord(payload) ? payload : {}
  const alerts = root.alerts
  const firstAlert = Array.isArray(alerts) && isRecord(alerts[0]) ? alerts[0] : {}
  return [
    root,
    recordAt(root, 'data'),
    recordAt(root, 'event'),
    recordAt(root, 'alert'),
    firstAlert,
    recordAt(firstAlert, 'labels'),
    recordAt(firstAlert, 'annotations'),
    recordAt(root, 'commonLabels'),
    recordAt(root, 'commonAnnotations'),
  ].filter((scope) => Object.keys(scope).length > 0)
}

/** Every non-empty text under `keys`, scope by scope, in order. */
function candidates(scopes: readonly JsonRecord[], keys: readonly string[]): string[] {
  return scopes.flatMap((scope) => keys.map((key) => textAt(scope, key)).filter((text) => text !== ''))
}

function mapped(payload: unknown, mapping: WebhookMapping, name: WebhookMappingField): string {
  const pointer = mapping[name]
  if (pointer === undefined) {
    return ''
  }
  const value = atPointer(payload, pointer)
  if (typeof value === 'string') {
    return value.trim()
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
}

/** The user's pointer first, then the best-effort keys; `accept` filters what counts. */
function field<T>(
  payload: unknown,
  context: ParseContext,
  name: WebhookMappingField,
  accept: (text: string) => T | null,
): T | null {
  const scopes = scopesOf(payload)
  const texts = [mapped(payload, context.mapping, name), ...candidates(scopes, KEYS[name])]
  for (const text of texts) {
    const value = text === '' ? null : accept(text)
    if (value !== null) {
      return value
    }
  }
  return null
}

const httpUrl = (text: string) => (URL.canParse(text) && /^https?:$/.test(new URL(text).protocol) ? text : null)

function defaultSeverity(state: ChannelState | null): EaNoticeSeverity {
  if (state === null) {
    return 'info'
  }
  return state === 'down' ? 'critical' : 'success'
}

/** Best-effort fields of any JSON alert, with the channel's JSON pointers taking precedence. */
export function parseGeneric(payload: unknown, context: ParseContext): Parsed {
  if (!isRecord(payload) && !Array.isArray(payload)) {
    return { kind: 'ignore', reason: 'payload is not a JSON object' }
  }
  const scopes = scopesOf(payload)
  const title = firstLine(field(payload, context, 'title', (text) => text) ?? '')
  const detail = candidates(scopes, KEYS.detail).find((text) => firstLine(text) !== title) ?? ''
  const state = field(payload, context, 'state', stateOf)
  const subject = state === null ? null : field(payload, context, 'subject', (text) => text)
  const tracked = subject === null ? null : state
  const time = candidates(scopes, KEYS.time)
    .map(timeOf)
    .find((iso) => iso !== null)
  return {
    kind: 'event',
    fields: {
      source: candidates(scopes, KEYS.source)[0] ?? context.channelName,
      severity: field(payload, context, 'severity', severityOf) ?? defaultSeverity(tracked),
      title: title === '' ? `Event from ${context.channelName}` : title,
      kind: field(payload, context, 'kind', (text) => text) ?? '',
      detail,
      url: field(payload, context, 'url', httpUrl),
      occurred_at: time ?? new Date().toISOString(),
      ...(subject === null || tracked === null ? {} : { subject, state: tracked }),
    },
  }
}

export const genericPreset: WebhookPresetAdapter = {
  verify: (request, secret) => {
    const signature = request.headers.get(SETI_SIGNATURE)
    if (signature !== null) {
      return verifyHmac(signature, 'sha256=', request.body, secret)
    }
    const authorization = request.headers.get('authorization') ?? ''
    if (!BEARER.test(authorization)) {
      return { ok: false, reason: 'missing signature' }
    }
    const bearer = authorization.slice('bearer'.length).trim()
    return safeEqual(bearer, secret) ? { ok: true } : { ok: false, reason: 'bearer secret mismatch' }
  },
  deliveryId: (headers) => headers.get(SETI_DELIVERY)?.trim() ?? null,
  decode: decodeJson,
  parse: (payload, _headers, context) => parseGeneric(payload, context),
  sample: (secret, nonce) => {
    const body = JSON.stringify({
      title: 'Test event from Seti',
      message: 'Sent from Settings, Channels to check this webhook.',
      severity: 'info',
      id: nonce,
    })
    const headers = {
      'content-type': 'application/json',
      [SETI_SIGNATURE]: `sha256=${hmacHex(secret, body)}`,
      [SETI_DELIVERY]: nonce,
    }
    return { headers, body }
  },
}
