import type {
  ChannelInfo,
  ChannelSubscription,
  channelSubscribeInput,
  PollerChannelInfo,
  WebhookChannelInfo,
} from '@seti/shared'
import { z } from 'zod'
import { anyTask, liveTask, pickOne } from './refs.js'
import { ToolRefusal } from './tool.js'
import { listChannels } from '../channels/actions.js'

export const channelRef = z
  .string()
  .trim()
  .min(1)
  .describe("The channel's name or id: a webhook, a poller or a reminder.")
export const webhookRef = z.string().trim().min(1).describe("The webhook's name or id.")
export const pollerRef = z.string().trim().min(1).describe("The poller's name or id.")
export const subscriberRef = z
  .string()
  .trim()
  .min(1)
  .describe("ea for the EA's inbox, or an agent's id or title; yourself included.")

export async function findChannel(ref: string): Promise<ChannelInfo> {
  return pickOne(await listChannels(), ref, 'channel', (c) => [c.id, c.name])
}

/** Which tools change a channel of each source, for a refusal that points the right way. */
const TOOLS_FOR = {
  webhook: 'get_channel or update_channel',
  poller: 'update_poller, run_channel or test_channel_script',
  reminder: 'update_channel, run_channel or test_channel_script',
} as const

const notA = (info: ChannelInfo, wanted: string) =>
  new ToolRefusal(`${info.name} is a ${info.source}, not a ${wanted}: use ${TOOLS_FOR[info.source]}.`)

export async function findWebhook(ref: string): Promise<WebhookChannelInfo> {
  const info = await findChannel(ref)
  if (info.source !== 'webhook') {
    throw notA(info, 'webhook')
  }
  return info
}

export async function findPoller(ref: string): Promise<PollerChannelInfo> {
  const info = await findChannel(ref)
  if (info.source !== 'poller') {
    throw notA(info, 'poller')
  }
  return info
}

const EA_REFS = new Set(['ea', 'the ea', 'inbox', "the ea's inbox"])

/** The subscription target a subscriber names, and a name for it. */
export async function subscriberOf(
  ref: string,
  forWrite: boolean,
): Promise<{ target: z.input<typeof channelSubscribeInput>; who: string }> {
  if (EA_REFS.has(ref.trim().toLowerCase())) {
    return { target: { target: 'ea' }, who: "the EA's inbox" }
  }
  const task = forWrite ? await liveTask(ref) : await anyTask(ref)
  return { target: { target: 'task', task_id: task.id }, who: `the agent "${task.title}"` }
}

export const existingSubscription = (info: ChannelInfo, target: z.input<typeof channelSubscribeInput>) =>
  info.subscriptions.find(
    (sub) => sub.target === target.target && sub.task_id === ('task_id' in target ? target.task_id : null),
  )

/** A subscription as an agent needs it: who takes the events and which kinds. */
export const subscriberView = (sub: ChannelSubscription) => ({
  subscription_id: sub.id,
  target: sub.target,
  ...(sub.task_id === null ? {} : { task_id: sub.task_id, title: sub.task_title, archived: sub.task_archived }),
  events: sub.events ?? 'every event',
  ...(sub.target === 'ea' ? { mode: sub.mode } : {}),
})
