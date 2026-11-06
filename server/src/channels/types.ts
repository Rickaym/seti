import type { ChannelState, EaNoticeSeverity, WebhookMapping } from '@seti/shared'

/** One event a webhook reported, before Seti dedupes, stores and routes it. */
export interface ChannelEventDraft {
  /** What reported it, such as a project or monitor name. */
  source: string
  severity: EaNoticeSeverity
  title: string
  detail: string
  url: string | null
  /** What happened, such as pull_request.opened; subscriptions filter on it. */
  kind: string
  /** Seti stores and routes each key once per channel. */
  dedupe_key: string
  occurred_at: string
  /**
   * What `state` belongs to, such as a monitor id. Seti keeps the last state per subject and routes
   * only changes: a subject first seen up sets a baseline, one first seen down is reported.
   */
  subject?: string
  state?: ChannelState
}

/** What a preset reads from a payload; the receiver sets the dedupe key and normalizes the kind. */
export type EventFields = Omit<ChannelEventDraft, 'dedupe_key' | 'kind'> & { kind?: string }

/** A verified webhook request: its headers and the raw body the signature covers. */
export interface WebhookRequest {
  headers: Headers
  body: Buffer
}

export type Verdict = { ok: true } | { ok: false; reason: string }

/**
 * A payload maps to one event, or to nothing worth reporting, with the reason; busy asks the
 * sender to try again later, as when the mod that reads it has a full queue.
 */
export type Parsed =
  { kind: 'event'; fields: EventFields } | { kind: 'ignore'; reason: string } | { kind: 'busy'; reason: string }

export interface ParseContext {
  channelName: string
  mapping: WebhookMapping
}

/** A request the preset signs as its sender would, for the "Send test event" button. */
interface SampleDelivery {
  headers: Record<string, string>
  body: string
}

/** How one kind of sender signs, identifies and shapes its deliveries. */
export interface WebhookPresetAdapter {
  verify: (request: WebhookRequest, secret: string) => Verdict
  /** The sender's own id for this delivery, when it sends one. */
  deliveryId: (headers: Headers) => string | null
  /** The JSON payload, or a reason to refuse the body. */
  decode: (request: WebhookRequest) => { ok: true; payload: unknown } | { ok: false; status: 400 | 415; reason: string }
  parse: (payload: unknown, headers: Headers, context: ParseContext) => Parsed | Promise<Parsed>
  sample: (secret: string, nonce: string) => SampleDelivery
}
