import {
  eventKindMatches,
  type ChannelEvent,
  type ChannelInput,
  type ChannelRoute,
  type ChannelSubscription,
} from '@seti/shared'
import { now } from '../db.js'
import { routeChannelEvent } from '../ea-inbox.js'
import { deliverInputs, type InputOutcome } from '../inputs.js'
import { channelRouting, ROUTE_ATTEMPTS } from '../store/channel-routing.js'
import { channelSubscriptions } from '../store/channel-subscriptions.js'

/** A channel event as the update a subscribed task's agent reads. */
const channelInput = (event: ChannelEvent, channelName: string): ChannelInput => ({
  source: 'channel',
  kind: event.kind,
  channel: channelName,
  channel_id: event.channel,
  event_id: event.id,
  severity: event.severity,
  subject: event.source,
  title: event.title,
  body: event.detail,
  url: event.url,
  received_at: event.created_at,
})

async function deliver(sub: ChannelSubscription, event: ChannelEvent): Promise<InputOutcome> {
  if (!eventKindMatches(sub.events, event.kind)) {
    return { outcome: 'skipped', reason: `Filtered out: ${event.kind === '' ? 'the event has no kind' : event.kind}` }
  }
  if (sub.task_id === null) {
    await routeChannelEvent(event, sub.mode === 'act')
    return { outcome: 'delivered', reason: 'Queued in the EA inbox' }
  }
  return deliverInputs(sub.task_id, [channelInput(event, sub.channel_name)])
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Fans a stored event out to every subscriber of its channel whose filter takes it, skipping the
 * ones it reached before. A subscriber that fails does not hold up the rest: the event stays
 * unrouted, and the sweeper tries again for the subscribers it missed.
 */
export async function routeEvent(event: ChannelEvent): Promise<ChannelRoute[]> {
  const reached = await channelRouting.reached(event.id)
  const routes: ChannelRoute[] = []
  const failed: string[] = []
  for (const sub of await channelSubscriptions.forChannel(event.channel)) {
    const label = sub.target === 'ea' ? 'EA' : (sub.task_title ?? 'a deleted task')
    const to = { target: sub.target, task_id: sub.task_id, label }
    if (reached.has(sub.id)) {
      continue
    }
    try {
      const outcome = await deliver(sub, event)
      await channelRouting.reach(event.id, sub.id, now())
      routes.push({ ...to, ...outcome })
    } catch (e) {
      failed.push(`${label}: ${message(e)}`)
      routes.push({ ...to, outcome: 'retrying', reason: `Seti will try again: ${message(e)}` })
    }
  }
  if (failed.length === 0) {
    await channelRouting.routed(event.id, now())
    return routes
  }
  const attempts = await channelRouting.failed(event.id, failed.join('; '), now())
  if (attempts >= ROUTE_ATTEMPTS) {
    process.stderr.write(`channels: gave up routing event ${String(event.id)}: ${failed.join('; ')}\n`)
  }
  return routes
}

const RETRY_MS = 30_000
const RETRY_BATCH = 20

/** Routes stored events that did not reach every subscriber, such as after a crash mid-route. */
export async function retryRouting(at = now()): Promise<number> {
  const due = await channelRouting.due(at, RETRY_BATCH)
  for (const event of due) {
    await routeEvent(event)
  }
  return due.length
}

/** Retries unrouted events now and every 30 s. */
export function startRouteRetries(): void {
  const retry = () => {
    retryRouting().catch((e: unknown) => {
      process.stderr.write(`channels: could not retry routing: ${message(e)}\n`)
    })
  }
  setInterval(retry, RETRY_MS).unref()
  retry()
}
