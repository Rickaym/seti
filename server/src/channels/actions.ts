import {
  type AuditKind,
  type ChannelInfo,
  type DeliveryTiming,
  type ChannelSecret,
  type ChannelEaMode,
  type ChannelSubscription,
  type channelCreateInput,
  type channelSubscribeInput,
  type channelUpdateInput,
  type SenderSampleResult,
  type senderSampleInput,
  type WebhookChannelInfo,
} from '@seti/shared'
import type { z } from 'zod'
import { audit } from '../audit.js'
import { fromDelegate, refuseAgent, refuseAtSelf, refuseOtherAgent } from '../ea-guard.js'
import { pollers } from '../pollers/service.js'
import { reminders } from '../reminders/service.js'
import { channelStore } from '../store/channels.js'
import { checkSample } from './sender-sample.js'
import { webhooks } from './service.js'
import { subscriptions } from './subscriptions.js'

export const SECRET_VALUES = 'handle webhook secrets'
export const SENDER_RULES = 'say how a webhook verifies its sender'

/** The EA and agents never see a secret Seti issues; the user takes it from Settings. */
const requester = () => ({ forEa: fromDelegate() })

const subscriberName = (sub: ChannelSubscription) => (sub.target === 'ea' ? 'the EA' : `"${sub.task_title ?? ''}"`)

const sourceWord = (sub: ChannelSubscription) =>
  sub.preset === 'poller' || sub.preset === 'reminder' ? sub.preset : 'webhook'

const filterWords = (events: readonly string[] | null) => (events === null ? 'every event' : events.join(', '))

/** A task's subscription shows in the task's audit trail; the EA's in the EA's. */
async function auditSubscription(
  kind: AuditKind,
  sub: ChannelSubscription,
  summary: string,
  change: Record<string, string | null> = {},
): Promise<void> {
  await audit.record({
    actor: 'user',
    kind,
    subject_type: sub.target,
    subject_id: sub.task_id ?? sub.channel_id,
    summary,
    detail: {
      channel: sub.channel_name,
      channel_id: sub.channel_id,
      target: sub.target,
      ...(sub.task_id === null ? {} : { task_id: sub.task_id, title: sub.task_title ?? '' }),
      events: sub.events === null ? null : [...sub.events],
      ...(sub.target === 'ea' ? { mode: sub.mode } : { delivery: sub.delivery }),
      ...change,
    },
  })
}

const byCreated = (a: ChannelInfo, b: ChannelInfo) =>
  a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at)

/** Webhooks, pollers and reminders, oldest first. */
export async function listChannels(): Promise<ChannelInfo[]> {
  return [...(await webhooks.list()), ...(await pollers.list()), ...(await reminders.list())].sort(byCreated)
}

export async function createChannel(input: z.output<typeof channelCreateInput>): Promise<ChannelSecret> {
  if (input.secret !== undefined) {
    refuseAgent(SECRET_VALUES)
  }
  if (input.sender !== undefined) {
    refuseAgent(SENDER_RULES)
  }
  const created = await webhooks.create(input, requester())
  const { id, name, preset, sender } = created.channel
  await audit.record({
    actor: 'user',
    kind: 'system.channel_created',
    subject_type: 'system',
    subject_id: id,
    summary: `Created the ${sender.label} webhook ${name}`,
    detail: { channel: name, preset, subscribe_ea: input.subscribe_ea },
  })
  return created
}

/** Checks a pasted request with a secret; it changes nothing, and stays the user's tool. */
export async function checkSenderSample(input: z.output<typeof senderSampleInput>): Promise<SenderSampleResult> {
  refuseAgent(SECRET_VALUES)
  return checkSample(input)
}

const CHANGED_WORDS = { name: 'name', mapping: 'mapping', sender_definition: 'sender' } as const

export async function updateChannel(
  id: string,
  change: z.output<typeof channelUpdateInput>,
): Promise<WebhookChannelInfo> {
  if (change.sender !== undefined) {
    refuseAgent(SENDER_RULES)
  }
  const before = await webhooks.info(id)
  const after = await webhooks.update(id, change)
  const changed = (['name', 'mapping', 'sender_definition'] as const).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  )
  if (changed.length > 0) {
    await audit.record({
      actor: 'user',
      kind: 'system.channel_changed',
      subject_type: 'system',
      subject_id: id,
      summary: `Changed the webhook ${after.name}: ${changed.map((key) => CHANGED_WORDS[key]).join(', ')}`,
      detail: { channel: after.name, changed: changed.map((key) => CHANGED_WORDS[key]) },
    })
  }
  return after
}

/** Issues a new secret, or takes the one the sender issued; only the user may give one. */
export async function rotateChannel(id: string, given: string | undefined): Promise<ChannelSecret> {
  if (given !== undefined) {
    refuseAgent(SECRET_VALUES)
  }
  const rotated = await webhooks.rotate(id, given, requester())
  await audit.record({
    actor: 'user',
    kind: 'system.channel_secret_rotated',
    subject_type: 'system',
    subject_id: id,
    summary: `Rotated the secret of the webhook ${rotated.channel.name}`,
    detail: { channel: rotated.channel.name, preset: rotated.channel.preset },
  })
  return rotated
}

export async function revealChannelSecret(id: string): Promise<ChannelSecret> {
  refuseAgent(SECRET_VALUES)
  const revealed = await webhooks.reveal(id)
  await audit.record({
    actor: 'user',
    kind: 'system.channel_secret_revealed',
    subject_type: 'system',
    subject_id: revealed.channel.id,
    summary: `Showed the secret of the webhook ${revealed.channel.name}`,
    detail: { channel: revealed.channel.name, preset: revealed.channel.preset },
  })
  return revealed
}

async function removeChannel(id: string): Promise<{ name: string; preset: string; word: string }> {
  const source = await channelStore.sourceOf(id)
  if (source === 'poller') {
    return { name: (await pollers.remove(id)).name, preset: 'poller', word: 'poller' }
  }
  if (source === 'reminder') {
    return { name: (await reminders.remove(id)).name, preset: 'reminder', word: 'reminder' }
  }
  const removed = await webhooks.remove(id)
  return { name: removed.name, preset: removed.preset, word: 'webhook' }
}

/** Deletes a webhook, whose URL stops working, or a poller or reminder, which stops running. */
export async function deleteChannel(id: string): Promise<void> {
  const removed = await removeChannel(id)
  await audit.record({
    actor: 'user',
    kind: 'system.channel_deleted',
    subject_type: 'system',
    subject_id: id,
    summary: `Deleted the ${removed.word} ${removed.name}`,
    detail: { channel: removed.name, preset: removed.preset },
  })
}

const DELIVERY_WORDS: Record<DeliveryTiming, string> = {
  now: 'it gets them at once, during a running turn too',
  after_turn: 'it gets them once its turn is over',
  with_message: "it gets them with the user's next message",
}

const deliveryWords = (delivery: DeliveryTiming | null) =>
  delivery === null ? 'it gets them as its update mode says' : DELIVERY_WORDS[delivery]

export async function subscribeChannel(
  id: string,
  input: z.output<typeof channelSubscribeInput>,
): Promise<ChannelSubscription> {
  if (input.target === 'task') {
    refuseOtherAgent(input.task_id)
  } else {
    refuseAtSelf("subscribe the EA's inbox")
  }
  const sub = await subscriptions.subscribe(id, input)
  const acts = sub.mode === 'act' ? '; it acts on them' : ''
  const when = sub.delivery === null ? '' : `; ${DELIVERY_WORDS[sub.delivery]}`
  const summary = `Subscribed ${subscriberName(sub)} to the ${sourceWord(sub)} ${sub.channel_name}: ${filterWords(sub.events)}${acts}${when}`
  await auditSubscription('system.channel_subscribed', sub, summary)
  return sub
}

export async function setChannelFilter(id: string, subId: number, events: string[] | null) {
  const sub = await subscriptions.setFilter(id, subId, events)
  const summary = `Set ${subscriberName(sub)} on the ${sourceWord(sub)} ${sub.channel_name} to take ${filterWords(sub.events)}`
  await auditSubscription('system.channel_filter_changed', sub, summary)
  return sub
}

const MODE_WORDS: Record<ChannelEaMode, string> = {
  report: 'report its alerts and ask before acting',
  act: 'hand its alerts to an agent without asking',
}

export async function setChannelMode(id: string, subId: number, mode: ChannelEaMode): Promise<ChannelSubscription> {
  const sub = await subscriptions.setMode(id, subId, mode)
  const summary = `Set the EA on the ${sourceWord(sub)} ${sub.channel_name} to ${MODE_WORDS[sub.mode]}`
  await auditSubscription('system.channel_mode_changed', sub, summary)
  return sub
}

/** Sets when the subscribed agent gets the channel's updates; null follows its update mode. */
export async function setChannelDelivery(
  id: string,
  subId: number,
  delivery: DeliveryTiming | null,
): Promise<ChannelSubscription> {
  const before = await subscriptions.get(id, subId)
  if (before.task_id !== null) {
    refuseOtherAgent(before.task_id)
  }
  const sub = await subscriptions.setDelivery(before, delivery)
  if (before.delivery !== sub.delivery) {
    const summary = `Set ${subscriberName(sub)} on the ${sourceWord(sub)} ${sub.channel_name}: ${deliveryWords(sub.delivery)}`
    await auditSubscription('system.channel_delivery_changed', sub, summary, {
      from: before.delivery,
      to: sub.delivery,
    })
  }
  return sub
}

export async function unsubscribeChannel(id: string, subId: number): Promise<ChannelSubscription> {
  const sub = await subscriptions.unsubscribe(id, subId)
  const summary = `Unsubscribed ${subscriberName(sub)} from the ${sourceWord(sub)} ${sub.channel_name}`
  await auditSubscription('system.channel_unsubscribed', sub, summary)
  return sub
}
