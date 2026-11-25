import type { DeliveryFilter, FollowedThread } from '@seti/shared'
import { redactSecrets } from '../scrub.js'
import { rememberSlackNames } from '../slack/directory.js'
import type { ChannelRecord } from '../store/channels.js'
import { channelThreads, threadReplies } from '../store/thread-replies.js'
import { threadSource, type InboundMessage, type ThreadSource } from './sources.js'

const HOUR_MS = 3_600_000
/** How long after an agent writes in a direct message the next messages there reach it. */
export const DM_WINDOW_MS = 24 * HOUR_MS
/** Characters of a reply Seti keeps until it hands the reply over; the update clips it again. */
const TEXT_MAX = 8000

const before = (at: string, ms: number) => new Date(Date.parse(at) - ms).toISOString()

/** A message event at a webhook with a thread switch on, as the thread matcher saw it. */
export interface ThreadMessage {
  /** How many followed threads it was queued for. */
  queued: number
  /** Whether it mentions the workspace user the sender's app is authorised for. */
  mentionsOwner: boolean
}

/** Whether a webhook reads replies at all; with both switches off it works as it did before. */
const reading = (channel: ChannelRecord) => channel.thread_replies || channel.thread_dms

async function targets(channel: ChannelRecord, msg: InboundMessage, at: string): Promise<FollowedThread[]> {
  if (msg.thread !== null) {
    return channel.thread_replies ? threadReplies.inThread(msg, msg.thread) : []
  }
  if (!msg.direct || !channel.thread_dms) {
    return []
  }
  const latest = await threadReplies.latestDirect(msg, before(at, DM_WINDOW_MS))
  return latest === undefined ? [] : [latest]
}

async function queue(source: ThreadSource, channel: ChannelRecord, msg: InboundMessage, at: string): Promise<number> {
  if (await threadReplies.isAgentSend(msg.service, msg.container, msg.message)) {
    return 0
  }
  const text = redactSecrets(msg.text).slice(0, TEXT_MAX)
  let queued = 0
  for (const follow of await targets(channel, msg, at)) {
    const url = source.link(follow.space, msg.container, msg.message, msg.thread ?? msg.message)
    if (await threadReplies.add({ follow: follow.id, msg, text, url }, at)) {
      queued += 1
    }
  }
  return queued
}

/**
 * Reads a message event at a webhook with a thread switch on for replies in followed threads and
 * queues each for routing (THR-2); notes that the webhook delivers message events. Null for any
 * other delivery, and for every delivery while both switches are off.
 */
export async function takeThreadMessage(
  channel: ChannelRecord,
  payload: unknown,
  at: string,
): Promise<ThreadMessage | null> {
  const source = threadSource(channel.preset)
  if (source === undefined || !reading(channel) || !source.isMessage(payload)) {
    return null
  }
  const author = source.profileName(payload)
  if (author !== null) {
    await rememberSlackNames([author], 'webhook delivery', at)
  }
  await channelThreads.sawMessage(channel.id, at, before(at, HOUR_MS))
  const msg = source.read(payload)
  const queued = msg === null ? 0 : await queue(source, channel, msg, at)
  return { queued, mentionsOwner: source.mentionsOwner(payload) }
}

/**
 * Why a message event stops before the subscribers, or null when it goes on: a filter that ran
 * decides; without one, only a message that mentions the app's user goes on (THR-3).
 */
export function heldMessage(thread: ThreadMessage, filter: DeliveryFilter | null): string | null {
  const routed =
    thread.queued === 0 ? 'in no followed thread' : `queued for ${String(thread.queued)} followed thread(s)`
  if (filter !== null && filter.outcome !== 'failed') {
    return filter.outcome === 'kept' || filter.outcome === 'changed' ? null : `a message ${routed}`
  }
  return thread.mentionsOwner ? null : `a message ${routed}; without a filter, subscribers get mentions only`
}
