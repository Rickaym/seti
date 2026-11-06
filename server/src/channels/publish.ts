import { EA_NOTICE_SEVERITIES, normalizeEventKind, type ChannelEvent, type ChannelRoute } from '@seti/shared'
import { redactCredentials } from '../scrub.js'
import type { ChannelEventDraft, EventFields } from './types.js'
import { channelStore, type Accepted } from '../store/channels.js'

const TEXT_MAX = { title: 200, detail: 2000, source: 100 } as const

export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

/** Hands a stored event to the channel's subscribers and says where it went. */
export type RouteEvent = (event: ChannelEvent) => Promise<ChannelRoute[]>

/** An event as every source stores it: clipped, credentials redacted, a known severity and kind. */
export function eventDraft(fields: EventFields, dedupeKey: string): ChannelEventDraft {
  const occurred = Date.parse(fields.occurred_at)
  return {
    ...fields,
    severity: EA_NOTICE_SEVERITIES.includes(fields.severity) ? fields.severity : 'info',
    source: clip(redactCredentials(fields.source), TEXT_MAX.source),
    title: clip(redactCredentials(fields.title), TEXT_MAX.title),
    detail: clip(redactCredentials(fields.detail), TEXT_MAX.detail),
    url: fields.url !== null && URL.canParse(fields.url) ? fields.url : null,
    kind: normalizeEventKind(redactCredentials(fields.kind ?? '')),
    dedupe_key: dedupeKey,
    occurred_at: Number.isNaN(occurred) ? new Date().toISOString() : new Date(occurred).toISOString(),
  }
}

/** Where a routed event went, in the words the delivery log keeps. */
export function routedReason(routes: readonly ChannelRoute[]): string {
  if (routes.length === 0) {
    return 'stored; no subscribers'
  }
  const reached = routes.filter((route) => !['skipped', 'ignored', 'retrying'].includes(route.outcome))
  const names = reached.map((route) => (route.target === 'ea' ? 'the EA inbox' : route.label))
  return clip(names.length === 0 ? 'stored; no subscriber took it' : `sent to ${names.join(', ')}`, TEXT_MAX.title)
}

export interface Published {
  accepted: Accepted
  routes: ChannelRoute[]
}

/** Every source's path for an event: stored once per dedupe key, then routed to subscribers. */
export async function publishEvent(
  channelId: string,
  draft: ChannelEventDraft,
  { at, route, claim = null }: { at: string; route: RouteEvent; claim?: { id: string; since: string } | null },
): Promise<Published> {
  const accepted = await channelStore.accept(channelId, claim, draft, at)
  const routes = accepted.kind === 'event' ? await route(accepted.event) : []
  return { accepted, routes }
}
