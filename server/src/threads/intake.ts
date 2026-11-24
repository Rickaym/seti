import type { FollowedThread } from '@seti/shared'
import { redactSecrets } from '../scrub.js'
import type { ChannelRecord } from '../store/channels.js'
import { channelThreads, threadReplies } from '../store/thread-replies.js'
import { threadSource, type InboundMessage, type ThreadSource } from './sources.js'

const HOUR_MS = 3_600_000
/** How long after an agent writes in a direct message the next messages there reach it. */
export const DM_WINDOW_MS = 24 * HOUR_MS
/** Characters of a reply Seti keeps until it hands the reply over; the update clips it again. */
const TEXT_MAX = 8000

const before = (at: string, ms: number) => new Date(Date.parse(at) - ms).toISOString()

/** What a webhook delivery is to the thread matcher. */
export interface ThreadMessage {
  /** A message event of a sender Seti reads threads from; it passes on only through the filter. */
  message: boolean
  /** How many followed threads it was queued for. */
  queued: number
}

const NOT_A_MESSAGE: ThreadMessage = { message: false, queued: 0 }

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
  if (!channel.thread_replies && !channel.thread_dms) {
    return 0
  }
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
 * Reads a verified delivery for replies in threads agents follow and queues each for routing
 * (THR-2). Notes that the webhook delivers message events, so Settings can say step 1 is done.
 */
export async function takeThreadMessage(channel: ChannelRecord, payload: unknown, at: string): Promise<ThreadMessage> {
  const source = threadSource(channel.preset)
  if (source?.isMessage(payload) !== true) {
    return NOT_A_MESSAGE
  }
  await channelThreads.sawMessage(channel.id, at, before(at, HOUR_MS))
  const msg = source.read(payload)
  return { message: true, queued: msg === null ? 0 : await queue(source, channel, msg, at) }
}
