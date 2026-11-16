import type { ChannelDelivery, ChannelEvent, WebhookChannelInfo } from '@seti/shared'
import { subscriberView } from './channel-refs.js'

const ACTIVITY_SHOWN = 5

const SECRET_STATES = {
  reveal: 'Its secret waits for the user, who copies it once from Settings, Channels into the sender.',
  paste: 'Its secret is still missing: the user pastes the one the sender issued in Settings, Channels.',
} as const

const eventView = ({ title, kind, severity, url, created_at }: ChannelEvent) => ({
  title,
  kind,
  severity,
  url,
  created_at,
})

export const deliveryView = ({ received_at, status, http_status, reason, routes }: ChannelDelivery) => ({
  received_at,
  status,
  http_status,
  reason,
  routes: routes.map(({ target, task_id, outcome, reason: why }) => ({ target, task_id, outcome, reason: why })),
})

/** A webhook as an agent needs it: where senders post, how it signs, and never its secret. */
export const webhookView = (info: WebhookChannelInfo, shown = ACTIVITY_SHOWN) => ({
  id: info.id,
  name: info.name,
  source: info.source,
  preset: info.preset,
  sender: info.sender.label,
  ...(info.unavailable === null ? {} : { refuses_deliveries: info.unavailable }),
  url: info.public_url ?? info.path,
  signs_with: info.sender.signature,
  mapping: info.mapping,
  secret: info.secret_pending === null ? 'set' : SECRET_STATES[info.secret_pending],
  secret_rotated_at: info.secret_rotated_at,
  subscribers: info.subscriptions.map(subscriberView),
  recent_events: info.recent.slice(0, shown).map(eventView),
  deliveries: info.deliveries.slice(0, shown).map(deliveryView),
})
