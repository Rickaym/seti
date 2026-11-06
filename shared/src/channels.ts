import { z } from 'zod'
import { webhookSourceId, type WebhookSourceInfo } from './channel-sources.js'
import type { EaNoticeSeverity } from './ea.js'
import { POLLER_EVENT_KINDS, type PollerInfo } from './pollers.js'
import { REMINDER_EVENT_KINDS, type ReminderInfo } from './reminders.js'

/** A change a channel reports for one subject, such as a monitor going down. */
export type ChannelState = 'down' | 'up'

/** One event a notification channel reported, as Seti stored it. */
export interface ChannelEvent {
  id: number
  channel: string
  source: string
  severity: EaNoticeSeverity
  title: string
  detail: string
  url: string | null
  dedupe_key: string
  /** What happened, such as pull_request.opened; subscriptions filter on it. Empty when unknown. */
  kind: string
  subject: string | null
  state: ChannelState | null
  occurred_at: string
  created_at: string
}

/** Where webhook deliveries arrive: the only path Access leaves to the sender's signature. */
export const HOOKS_PREFIX = '/hooks/'

/** Where a channel's events come from: a sender's webhook, Seti polling a service, or a reminder. */
export type ChannelSource = 'webhook' | 'poller' | 'reminder'

export const WEBHOOK_MAPPING_FIELDS = ['title', 'kind', 'severity', 'url', 'subject', 'state'] as const
export type WebhookMappingField = (typeof WEBHOOK_MAPPING_FIELDS)[number]

const jsonPointer = z
  .string()
  .max(200)
  .regex(/^(\/([^~/]|~[01])*)+$/, 'must be a JSON pointer such as /alert/title')

/** JSON pointers into a generic payload; unset fields use the best-effort mapping. */
export const webhookMapping = z
  .object({
    title: jsonPointer.optional(),
    kind: jsonPointer.optional(),
    severity: jsonPointer.optional(),
    url: jsonPointer.optional(),
    subject: jsonPointer.optional(),
    state: jsonPointer.optional(),
  })
  .strict()
export type WebhookMapping = z.output<typeof webhookMapping>

/** How many of its newest runs, events and deliveries each channel lists. */
export const CHANNEL_ACTIVITY_SHOWN = 3

export const CHANNEL_DELIVERY_STATUSES = ['accepted', 'duplicate', 'ignored', 'rejected', 'rate_limited'] as const
export type ChannelDeliveryStatus = (typeof CHANNEL_DELIVERY_STATUSES)[number]

/** An event kind as Seti stores and filters it: lowercase, with runs of spaces as one underscore. */
export const normalizeEventKind = (text: string) => text.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 80)

/** Who a channel's events go to: the EA's inbox, or a task's agent as an update. */
export const CHANNEL_TARGETS = ['ea', 'task'] as const
export type ChannelTarget = (typeof CHANNEL_TARGETS)[number]

/** How the EA treats a channel's alerts: report and ask, or hand the work to an existing agent. */
export const CHANNEL_EA_MODES = ['report', 'act'] as const
export type ChannelEaMode = (typeof CHANNEL_EA_MODES)[number]

/** One subscriber of a channel, with the event kinds it takes; null takes every event. */
export interface ChannelSubscription {
  id: number
  channel_id: string
  channel_name: string
  /** A webhook's source id, such as generic or github-webhooks.github; else poller or reminder. */
  preset: string
  target: ChannelTarget
  task_id: string | null
  task_title: string | null
  /** An archived task keeps its subscription but gets nothing until it is restored. */
  task_archived: boolean
  events: string[] | null
  /** For the EA: act hands an alert's work to an existing agent unasked; tasks always report. */
  mode: ChannelEaMode
  created_at: string
}

/** Event kinds a channel reports, offered when filtering a subscription. */
export function channelKinds(info: ChannelInfo): readonly string[] {
  switch (info.source) {
    case 'poller':
      return POLLER_EVENT_KINDS
    case 'reminder':
      return REMINDER_EVENT_KINDS
    case 'webhook':
      return info.sender.kinds
  }
}

/** A filter entry takes that kind and every kind under it: pull_request takes pull_request.closed. */
export function eventKindMatches(events: readonly string[] | null, kind: string): boolean {
  return events === null || events.some((entry) => kind === entry || kind.startsWith(`${entry}.`))
}

/** retrying: the subscriber failed to take the event, and Seti tries again shortly. */
export const CHANNEL_ROUTE_OUTCOMES = ['delivered', 'queued', 'held', 'ignored', 'skipped', 'retrying'] as const
export type ChannelRouteOutcome = (typeof CHANNEL_ROUTE_OUTCOMES)[number]

export interface ChannelRoute {
  target: ChannelTarget
  task_id: string | null
  /** The subscriber's name when Seti routed the event: EA, or the task's title. */
  label: string
  outcome: ChannelRouteOutcome
  reason: string
}

/** One request to a webhook, or one event a poller found, and whatever became of it. */
export interface ChannelDelivery {
  id: number
  channel: string
  received_at: string
  status: ChannelDeliveryStatus
  /** The status Seti answered a webhook request with; 0 for an event a poller found. */
  http_status: number
  reason: string
  /** The sender's delivery id, or the body's SHA-256 when it sends none. */
  delivery_id: string | null
  event_id: number | null
  /** The start of a verified body with credentials redacted; empty for unverified ones. */
  excerpt: string
  /** Where the event went, one entry per subscriber; empty when no event was stored. */
  routes: ChannelRoute[]
}

/** reveal: a secret Seti issued for the EA, shown once in Settings; paste: the sender's is due. */
export type ChannelSecretPending = 'reveal' | 'paste'

/** What every channel has, whatever its source. */
interface ChannelCommon {
  id: string
  name: string
  created_at: string
  updated_at: string
  subscriptions: ChannelSubscription[]
  recent: ChannelEvent[]
  deliveries: ChannelDelivery[]
}

export interface WebhookChannelInfo extends ChannelCommon {
  source: 'webhook'
  preset: string
  /** The kind of sender it takes, as its source or the manifest of its mod describes it. */
  sender: WebhookSourceInfo
  /** Why it refuses every delivery now, such as its mod being off; null while it takes them. */
  unavailable: string | null
  /** Path of the webhook on this Seti, under HOOKS_PREFIX. */
  path: string
  /** The full public URL when Seti has a public hostname. */
  public_url: string | null
  mapping: WebhookMapping
  secret_rotated_at: string | null
  secret_pending: ChannelSecretPending | null
}

export interface PollerChannelInfo extends ChannelCommon {
  source: 'poller'
  preset: 'poller'
  poller: PollerInfo
}

export interface ReminderChannelInfo extends ChannelCommon {
  source: 'reminder'
  preset: 'reminder'
  reminder: ReminderInfo
}

export type ChannelInfo = WebhookChannelInfo | PollerChannelInfo | ReminderChannelInfo

/** A new or rotated webhook; `secret` is shown this once, and null when the sender issued it. */
export interface ChannelSecret {
  channel: WebhookChannelInfo
  secret: string | null
}

const channelName = z.string().trim().min(1).max(80)
const senderSecret = z.string().trim().min(16).max(256)

export const channelCreateInput = z.object({
  name: channelName,
  preset: webhookSourceId,
  subscribe_ea: z.boolean().default(false),
  secret: senderSecret.optional(),
  mapping: webhookMapping.default({}),
})
export type ChannelCreateInput = z.input<typeof channelCreateInput>

export const channelUpdateInput = z
  .object({ name: channelName.optional(), mapping: webhookMapping.optional() })
  .refine((input) => Object.values(input).some((value) => value !== undefined), 'Change at least one field')
export type ChannelUpdateInput = z.input<typeof channelUpdateInput>

export const channelRotateInput = z.object({ secret: senderSecret.optional() })
export type ChannelRotateInput = z.input<typeof channelRotateInput>

const eventKind = z
  .string()
  .transform(normalizeEventKind)
  .refine((kind) => kind !== '' && !kind.includes(','), 'An event kind is a word such as pull_request.opened')

/** Event kinds a subscription takes; empty or null takes every event. */
const eventFilter = z
  .array(eventKind)
  .max(20)
  .nullable()
  .transform((events) => (events === null || events.length === 0 ? null : [...new Set(events)]))

export const channelSubscribeInput = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('ea'),
    events: eventFilter.default(null),
    mode: z.enum(CHANNEL_EA_MODES).default('report'),
  }),
  z.object({ target: z.literal('task'), task_id: z.string().min(1).max(100), events: eventFilter.default(null) }),
])
export type ChannelSubscribeInput = z.input<typeof channelSubscribeInput>

export const channelFilterInput = z.object({ events: eventFilter })
export type ChannelFilterInput = z.input<typeof channelFilterInput>

export const channelModeInput = z.object({ mode: z.enum(CHANNEL_EA_MODES) })
export type ChannelModeInput = z.input<typeof channelModeInput>
