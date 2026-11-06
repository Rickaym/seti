import { randomUUID } from 'node:crypto'
import type { ChannelDeliveryStatus, ChannelRoute } from '@seti/shared'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { redactSecrets } from '../scrub.js'
import { clip, eventDraft, publishEvent, routedReason, type RouteEvent } from './publish.js'
import { createRateLimiter } from './rate-limit.js'
import { HOOK_ID, sha256Hex } from './signature.js'
import { webhookSender } from './source-info.js'
import { webhookSources } from './sources.js'
import type { WebhookRequest } from './types.js'
import { channelStore, type Accepted, type ChannelRecord } from '../store/channels.js'

export const HOOK_BODY_MAX = 256 * 1024
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000
const EXCERPT_MAX = 1000
const TEXT_MAX = { title: 200, id: 200 } as const

export interface HookResult {
  http: ContentfulStatusCode
  status: ChannelDeliveryStatus | 'not_found'
  reason: string
  retryAfterS?: number
}

type Recorded = HookResult & { status: ChannelDeliveryStatus }

interface RateLimits {
  perChannel: number
  global: number
  windowMs: number
}

export interface ReceiverDeps {
  route: RouteEvent
  limits?: RateLimits
  now?: () => Date
}

const DEFAULT_LIMITS: RateLimits = { perChannel: 60, global: 600, windowMs: 60_000 }

const NOT_FOUND: HookResult = { http: 404, status: 'not_found', reason: 'no such webhook' }
const UNREADABLE_SECRET = 'the stored secret does not open with the current key; rotate it'
const SECRET_TO_PASTE = "the sender's secret is not pasted yet; paste it in Settings, Channels"

/** Reads at most `max` bytes; null when the body is larger, whatever Content-Length said. */
async function readCapped(request: Request, max: number): Promise<Buffer | null> {
  if (Number(request.headers.get('content-length') ?? 0) > max) {
    return null
  }
  if (request.body === null) {
    return Buffer.alloc(0)
  }
  const reader = (request.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function outcomeOf(accepted: Accepted, routes: readonly ChannelRoute[]): Omit<Recorded, 'http'> {
  switch (accepted.kind) {
    case 'event':
      return { status: 'accepted', reason: routedReason(routes) }
    case 'duplicate':
      return { status: 'duplicate', reason: 'delivery seen in the last 24 hours' }
    case 'unchanged':
      return { status: 'duplicate', reason: `state unchanged: still ${accepted.state}` }
    case 'baseline':
      return { status: 'ignored', reason: 'first report is up; kept as the baseline' }
  }
}

/** Verifies, dedupes, parses and stores webhook deliveries, and records every one of them. */
export function createReceiver(deps: ReceiverDeps) {
  const limits = deps.limits ?? DEFAULT_LIMITS
  const now = deps.now ?? (() => new Date())
  const clock = () => now().getTime()
  const channelLimit = createRateLimiter(limits.perChannel, limits.windowMs, clock)
  const globalLimit = createRateLimiter(limits.global, limits.windowMs, clock)

  async function finish(
    channel: ChannelRecord,
    at: string,
    result: Recorded,
    extra: { delivery_id?: string | null; event_id?: number; excerpt?: string; routes?: ChannelRoute[] } = {},
  ): Promise<HookResult> {
    await channelStore.delivered({
      channel: channel.id,
      received_at: at,
      status: result.status,
      http_status: result.http,
      reason: result.reason,
      delivery_id: extra.delivery_id ?? null,
      event_id: extra.event_id ?? null,
      excerpt: extra.excerpt ?? '',
      routes: extra.routes ?? [],
    })
    if (result.status === 'rejected') {
      process.stderr.write(`hooks: refused a delivery to ${channel.name}: ${result.reason}\n`)
    }
    return result
  }

  /** Everything after the body is read; the test button enters here with a signed sample. */
  async function handle(channel: ChannelRecord, request: WebhookRequest, at: string): Promise<HookResult> {
    const preset = webhookSources.get(channel.preset)?.adapter
    if (preset === undefined) {
      const reason = webhookSender(channel.preset).unavailable ?? 'no source reads it'
      return finish(channel, at, { http: 503, status: 'rejected', reason })
    }
    if (channel.secret === null) {
      return finish(channel, at, { http: 401, status: 'rejected', reason: UNREADABLE_SECRET })
    }
    if (channel.secret_pending === 'paste') {
      return finish(channel, at, { http: 401, status: 'rejected', reason: SECRET_TO_PASTE })
    }
    const verdict = preset.verify(request, channel.secret)
    if (!verdict.ok) {
      return finish(channel, at, { http: 401, status: 'rejected', reason: verdict.reason })
    }
    const decoded = preset.decode(request)
    if (!decoded.ok) {
      return finish(channel, at, { http: decoded.status, status: 'rejected', reason: decoded.reason })
    }
    const excerpt = clip(redactSecrets(JSON.stringify(decoded.payload)), EXCERPT_MAX)
    const sent = preset.deliveryId(request.headers)?.trim() ?? ''
    const deliveryId = sent === '' ? `sha256:${sha256Hex(request.body)}` : clip(sent, TEXT_MAX.id)
    const parsed = await preset.parse(decoded.payload, request.headers, {
      channelName: channel.name,
      mapping: channel.mapping,
    })
    if (parsed.kind === 'busy') {
      return finish(channel, at, { http: 503, status: 'rejected', reason: clip(parsed.reason, TEXT_MAX.title) })
    }
    if (parsed.kind === 'ignore') {
      const result: Recorded = { http: 200, status: 'ignored', reason: clip(parsed.reason, TEXT_MAX.title) }
      return finish(channel, at, result, { delivery_id: deliveryId, excerpt })
    }
    const since = new Date(Date.parse(at) - DEDUPE_WINDOW_MS).toISOString()
    const draft = eventDraft(parsed.fields, `${deliveryId}@${at}`)
    const claim = { id: deliveryId, since }
    const { accepted, routes } = await publishEvent(channel.id, draft, { at, route: deps.route, claim })
    const eventId = accepted.kind === 'event' ? { event_id: accepted.event.id } : {}
    const result: Recorded = { http: 200, ...outcomeOf(accepted, routes) }
    return finish(channel, at, result, { delivery_id: deliveryId, excerpt, routes, ...eventId })
  }

  return {
    /** One request to /hooks/<id>: unknown ids cost no writes, and floods stop before the body. */
    receive: async (id: string, request: Request): Promise<HookResult> => {
      if (!HOOK_ID.test(id)) {
        return NOT_FOUND
      }
      const overall = globalLimit('all')
      if (!overall.ok) {
        return { http: 429, status: 'rate_limited', reason: 'too many deliveries', retryAfterS: overall.retryAfterS }
      }
      const channel = await channelStore.get(id)
      if (channel === undefined) {
        return NOT_FOUND
      }
      const at = now().toISOString()
      const rate = channelLimit(id)
      if (!rate.ok) {
        const result: Recorded = {
          http: 429,
          status: 'rate_limited',
          reason: `over ${String(limits.perChannel)} deliveries a minute`,
          retryAfterS: rate.retryAfterS,
        }
        return rate.first ? finish(channel, at, result) : result
      }
      const body = await readCapped(request, HOOK_BODY_MAX)
      if (body === null) {
        return finish(channel, at, { http: 413, status: 'rejected', reason: 'body over 256 KB' })
      }
      return handle(channel, { headers: request.headers, body }, at)
    },
    /** Signs the preset's sample with the channel's secret and runs it through the same checks. */
    sendTest: async (channel: ChannelRecord): Promise<HookResult> => {
      if (channel.secret === null) {
        return finish(channel, now().toISOString(), { http: 401, status: 'rejected', reason: UNREADABLE_SECRET })
      }
      const source = webhookSources.get(channel.preset)
      if (source === undefined) {
        return handle(channel, { headers: new Headers(), body: Buffer.alloc(0) }, now().toISOString())
      }
      const sample = source.adapter.sample(channel.secret, randomUUID())
      const request = { headers: new Headers(sample.headers), body: Buffer.from(sample.body) }
      return handle(channel, request, now().toISOString())
    },
  }
}
