import {
  DELIVERY_TIMINGS,
  channelFilterInput,
  channelSubscribeInput,
  type DeliveryTiming,
  type ChannelSubscription,
} from '@seti/shared'
import { z } from 'zod'
import { setChannelDelivery, setChannelFilter, subscribeChannel, unsubscribeChannel } from '../channels/actions.js'
import {
  channelRef,
  existingSubscription,
  findChannel,
  subscriberOf,
  subscriberRef,
  subscriberView,
} from './channel-refs.js'
import { done, setiTool, ToolRefusal } from './tool.js'

/** What the caller asked for an existing subscription, with undefined for what stays. */
interface Wanted {
  events: string[] | null | undefined
  delivery: DeliveryTiming | null | undefined
}

/** Applies the filter and the delivery that differ; null when nothing does. */
async function change(channelId: string, existing: ChannelSubscription, wanted: Wanted) {
  const events =
    wanted.events === undefined && wanted.delivery !== undefined ? existing.events : (wanted.events ?? null)
  const refilter = JSON.stringify(existing.events) !== JSON.stringify(events)
  const retime = wanted.delivery !== undefined && wanted.delivery !== existing.delivery
  if (!refilter && !retime) {
    return null
  }
  const filtered = refilter ? await setChannelFilter(channelId, existing.id, events) : existing
  return retime ? setChannelDelivery(channelId, existing.id, wanted.delivery ?? null) : filtered
}

export const subscribeChannelTool = setiTool({
  name: 'subscribe_channel',
  description:
    "Have a channel deliver its events to an agent, yourself included, as updates it acts on under its update mode, or to the EA's inbox; or change which event kinds an existing subscriber takes, or when an agent gets them. Pinned agents suit this best.",
  input: {
    channel: channelRef,
    subscriber: subscriberRef,
    events: channelFilterInput.shape.events
      .optional()
      .describe('Event kinds it takes, such as pull_request or issue.created; leave out for every event.'),
    delivery: z
      .enum([...DELIVERY_TIMINGS, 'agent'])
      .optional()
      .describe(
        'Agents only, when the agent gets the updates: now starts a turn or joins the running one at its ' +
          "next step, after_turn waits for the running turn to end, with_message holds them for the user's " +
          "next message, agent follows the agent's update mode (the default). The agent's update mode caps " +
          'it: one that holds updates holds these too, and one that has them off drops them.',
      ),
  },
  run: async ({ channel, subscriber, events, delivery }) => {
    const info = await findChannel(channel)
    const { target, who } = await subscriberOf(subscriber, true)
    if (delivery !== undefined && target.target !== 'task') {
      throw new ToolRefusal("Only an agent's subscription has a delivery; the EA takes events into its inbox.")
    }
    const when = delivery === 'agent' ? null : delivery
    const existing = existingSubscription(info, target)
    if (existing === undefined) {
      const input = { ...target, events: events ?? null, ...(when === undefined ? {} : { delivery: when }) }
      return subscriberView(await subscribeChannel(info.id, channelSubscribeInput.parse(input)))
    }
    const changed = await change(info.id, existing, { events, delivery: when })
    return changed === null ? done(`${who} already takes those events from ${info.name}.`) : subscriberView(changed)
  },
})

export const unsubscribeChannelTool = setiTool({
  name: 'unsubscribe_channel',
  description: "Stop a channel delivering its events to an agent or to the EA's inbox.",
  input: { channel: channelRef, subscriber: subscriberRef },
  run: async ({ channel, subscriber }) => {
    const info = await findChannel(channel)
    const { target, who } = await subscriberOf(subscriber, false)
    const existing = existingSubscription(info, target)
    if (existing === undefined) {
      throw new ToolRefusal(`${who} does not subscribe to ${info.name}.`)
    }
    await unsubscribeChannel(info.id, existing.id)
    return done(`Unsubscribed ${who} from ${info.name}.`)
  },
})
