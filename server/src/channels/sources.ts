import type { WebhookSourceHandler } from '@seti/mod-api'
import {
  CORE_POLLER_TEMPLATE,
  CORE_WEBHOOK_SOURCE,
  modScoped,
  Registry,
  type ModWebhookSource,
  type PollerTemplateInfo,
  type WebhookSourceInfo,
} from '@seti/shared'
import { decodeJson, parseJsonText } from './payload.js'
import { genericPreset } from './preset-generic.js'
import { hmacHex, verifyHmac } from './signature.js'
import type { WebhookPresetAdapter, WebhookRequest } from './types.js'

/** A sender a webhook can take: what the user reads about it, and how Seti verifies and reads it. */
export interface WebhookSource {
  info: WebhookSourceInfo
  adapter: WebhookPresetAdapter
}

/** Senders webhooks take now: Seti's generic one and those of mods that are on. */
export const webhookSources = new Registry<WebhookSource>('webhook source', (source) => source.info.id)

/** Scripts a new poller can start from: Seti's blank one and those of mods that are on. */
export const pollerTemplates = new Registry<PollerTemplateInfo>('poller template', (template) => template.id)

webhookSources.register({
  info: {
    id: CORE_WEBHOOK_SOURCE,
    mod: null,
    label: 'Generic',
    description: 'Any JSON sender. Sign the body with HMAC-SHA256, or send the secret as a bearer token.',
    signature: 'X-Seti-Signature',
    secret: 'generated',
    kinds: [],
    setup:
      'The sender posts JSON to the URL and signs each request with X-Seti-Signature: sha256= and the hex ' +
      'HMAC-SHA256 of the body, keyed with the secret; a sender that cannot sign sends ' +
      'Authorization: Bearer and the secret instead.',
  },
  adapter: genericPreset,
})

pollerTemplates.register({
  id: CORE_POLLER_TEMPLATE,
  mod: null,
  label: 'Blank',
  description: 'An empty poll function to write from scratch.',
  script: `export default async function poll({ fetch, parseFeed, log, state, since }) {
  return []
}
`,
})

/** A mod's webhook source as the user reads it, from its manifest alone. */
export const modWebhookInfo = (mod: string, declared: ModWebhookSource): WebhookSourceInfo => ({
  id: modScoped(mod, declared.id),
  mod,
  label: declared.title,
  description: declared.description,
  signature: declared.signature.header,
  secret: declared.secret,
  kinds: [...declared.kinds],
  setup: declared.setup,
})

const FORM = /^application\/x-www-form-urlencoded\b/i

/** JSON, or a form whose payload field holds the JSON. */
function decodeForm(request: WebhookRequest): ReturnType<WebhookPresetAdapter['decode']> {
  if (!FORM.test(request.headers.get('content-type') ?? '')) {
    return decodeJson(request)
  }
  const payload = new URLSearchParams(request.body.toString('utf8')).get('payload')
  return payload === null ? { ok: false, status: 400, reason: 'form body has no payload' } : parseJsonText(payload)
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * How Seti verifies, identifies, decodes and signs samples for a mod's webhook source, from its
 * manifest alone, so the mod's code never sees the secret and reads only a verified body.
 */
export function modWebhookChecks(
  declared: ModWebhookSource,
  sample: WebhookSourceHandler['sample'],
): Omit<WebhookPresetAdapter, 'parse'> {
  const { header, prefix } = declared.signature
  return {
    verify: (request, secret) => verifyHmac(request.headers.get(header), prefix, request.body, secret),
    deliveryId: (headers) => (declared.delivery === undefined ? null : headers.get(declared.delivery)),
    decode: declared.formPayload ? decodeForm : decodeJson,
    sample: (secret, nonce) => {
      const { headers, body } = sample()
      const signed = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
      if (declared.delivery !== undefined) {
        signed[declared.delivery.toLowerCase()] = nonce
      }
      signed[header.toLowerCase()] = `${prefix}${hmacHex(secret, body)}`
      return { headers: signed, body }
    },
  }
}

/** How Seti verifies and reads a bundled mod's webhook source, with its server half's parser. */
export function modWebhookAdapter(
  name: string,
  declared: ModWebhookSource,
  handler: WebhookSourceHandler,
): WebhookPresetAdapter {
  return {
    ...modWebhookChecks(declared, handler.sample),
    parse: (payload, headers) => {
      try {
        return handler.parse(payload, headers)
      } catch (e) {
        return { kind: 'ignore', reason: `the ${name} mod could not read it: ${errorText(e)}` }
      }
    },
  }
}
