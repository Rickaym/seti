import type { ChannelEaMode, ChannelSubscription, channelSubscribeInput } from '@seti/shared'
import type { z } from 'zod'
import { now } from '../db.js'
import { HttpError } from '../http.js'
import { channelSubscriptions } from '../store/channel-subscriptions.js'
import { channelStore } from '../store/channels.js'
import { requireTask } from '../tasks.js'
import { signalWorkspaces } from '../workspace/dir.js'

/** A task's task.md lists its subscriptions, so each change rewrites it. */
function changed(sub: ChannelSubscription): ChannelSubscription {
  if (sub.task_id !== null) {
    signalWorkspaces('task', sub.task_id)
  }
  return sub
}

/** Throws 404 unless a webhook or poller channel has this id. */
async function requireChannel(id: string): Promise<void> {
  if ((await channelStore.sourceOf(id)) === undefined) {
    throw new HttpError(404, 'No such channel')
  }
}

async function subscriptionOf(channelId: string, id: number): Promise<ChannelSubscription> {
  const sub = await channelSubscriptions.get(id)
  if (sub?.channel_id !== channelId) {
    throw new HttpError(404, 'No such subscription on this channel')
  }
  return sub
}

/** Who a channel delivers to: the EA and tasks subscribe, each with an optional event filter. */
export const subscriptions = {
  list: async (channelId: string): Promise<ChannelSubscription[]> => {
    await requireChannel(channelId)
    return channelSubscriptions.forChannel(channelId)
  },
  forTask: async (taskId: string): Promise<ChannelSubscription[]> =>
    channelSubscriptions.forTask((await requireTask(taskId)).id),
  forEa: async (): Promise<ChannelSubscription[]> => channelSubscriptions.forEa(),
  subscribe: async (channelId: string, input: z.output<typeof channelSubscribeInput>): Promise<ChannelSubscription> => {
    await requireChannel(channelId)
    const task = input.target === 'task' ? await requireTask(input.task_id) : null
    if (task !== null && task.archived_at !== null) {
      throw new HttpError(400, `Restore "${task.title}" before subscribing it to a channel`)
    }
    const added = await channelSubscriptions.add({
      channel_id: channelId,
      target: input.target,
      task_id: task?.id ?? null,
      events: input.events,
      mode: input.target === 'ea' ? input.mode : 'report',
      created_at: now(),
    })
    if (added === undefined) {
      throw new HttpError(409, task === null ? 'The EA already subscribes' : `"${task.title}" already subscribes`)
    }
    return changed(added)
  },
  setFilter: async (channelId: string, id: number, events: string[] | null): Promise<ChannelSubscription> => {
    const sub = await subscriptionOf(channelId, id)
    return changed((await channelSubscriptions.setEvents(sub.id, events)) ?? sub)
  },
  /** Only the EA's subscription has a mode; an agent always takes events as updates. */
  setMode: async (channelId: string, id: number, mode: ChannelEaMode): Promise<ChannelSubscription> => {
    const sub = await subscriptionOf(channelId, id)
    if (sub.target !== 'ea') {
      throw new HttpError(400, 'Only the EA subscription has a report or act mode')
    }
    return (await channelSubscriptions.setMode(sub.id, mode)) ?? sub
  },
  unsubscribe: async (channelId: string, id: number): Promise<ChannelSubscription> => {
    const sub = await subscriptionOf(channelId, id)
    await channelSubscriptions.remove(sub.id)
    return changed(sub)
  },
}
