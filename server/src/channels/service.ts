import {
  CHANNEL_ACTIVITY_SHOWN,
  CORE_WEBHOOK_SOURCE,
  HOOKS_PREFIX,
  type ChannelSecret,
  type ChannelSecretPending,
  type WebhookChannelInfo,
  type WebhookSourceInfo,
  type channelCreateInput,
  type channelUpdateInput,
} from '@seti/shared'
import type { z } from 'zod'
import { PUBLIC_ACCESS } from '../config.js'
import { now } from '../db.js'
import { HttpError } from '../http.js'
import { createReceiver } from './receiver.js'
import { routeEvent } from './router.js'
import { newHookId, newSecret } from './signature.js'
import { requireWebhookSource, webhookSender } from './source-info.js'
import { channelSubscriptions } from '../store/channel-subscriptions.js'
import { channelStore, type ChannelRecord } from '../store/channels.js'
import { signalWorkspaces } from '../workspace/dir.js'

/** The receiver behind /hooks; its events go to each channel's subscribers. */
export const receiver = createReceiver({ route: routeEvent })

export const subscribedTasks = async (id: string) =>
  (await channelSubscriptions.forChannel(id)).flatMap((sub) => (sub.task_id === null ? [] : [sub.task_id]))

/** The task.md of each subscribed task names the channel, so a rename or delete rewrites it. */
export function signalTasks(taskIds: readonly string[]): void {
  for (const taskId of taskIds) {
    signalWorkspaces('task', taskId)
  }
}

async function info(record: ChannelRecord): Promise<WebhookChannelInfo> {
  const { id, name, preset, mapping, created_at, updated_at, secret_rotated_at, secret_pending } = record
  const path = `${HOOKS_PREFIX}${id}`
  return {
    source: 'webhook',
    id,
    name,
    preset,
    ...webhookSender(preset),
    mapping,
    created_at,
    updated_at,
    secret_rotated_at,
    secret_pending,
    path,
    public_url: PUBLIC_ACCESS === null ? null : `${PUBLIC_ACCESS.origin}${path}`,
    subscriptions: await channelSubscriptions.forChannel(id),
    recent: await channelStore.recent(id, CHANNEL_ACTIVITY_SHOWN),
    deliveries: await channelStore.deliveries(id, CHANNEL_ACTIVITY_SHOWN),
  }
}

async function recordOf(id: string): Promise<ChannelRecord> {
  const record = await channelStore.get(id)
  if (record === undefined) {
    throw new HttpError(404, 'No such webhook')
  }
  return record
}

interface IssuedSecret {
  secret: string
  /** The value the response may carry; null when the sender issued it or the user sees it later. */
  shown: string | null
  pending: ChannelSecretPending | null
}

/** Who asks decides where a new secret goes: the user sees it at once, the EA never does. */
interface Requester {
  forEa: boolean
}

const USER: Requester = { forEa: false }

/** Seti makes the secret unless the sender does; for the EA it waits for the user in Settings. */
function secretFor(
  { label, secret: source }: WebhookSourceInfo,
  given: string | undefined,
  { forEa }: Requester,
  creating: boolean,
): IssuedSecret {
  if (source === 'sender') {
    if (given !== undefined) {
      return { secret: given, shown: null, pending: null }
    }
    if (forEa && creating) {
      return { secret: newSecret(), shown: null, pending: 'paste' }
    }
    throw new HttpError(400, `Paste the secret ${label} issued for this webhook`)
  }
  if (given !== undefined) {
    throw new HttpError(400, `Seti generates the secret for ${label} webhooks`)
  }
  const secret = newSecret()
  return forEa ? { secret, shown: null, pending: 'reveal' } : { secret, shown: secret, pending: null }
}

/** Webhook channels: create, change, rotate, delete and test them; secrets never leave but once. */
export const webhooks = {
  list: async (): Promise<WebhookChannelInfo[]> =>
    Promise.all((await channelStore.list()).map(async (record) => info(record))),
  info: async (id: string): Promise<WebhookChannelInfo> => info(await recordOf(id)),
  create: async (input: z.output<typeof channelCreateInput>, requester = USER): Promise<ChannelSecret> => {
    const { info: sender } = requireWebhookSource(input.preset)
    const { secret, shown, pending } = secretFor(sender, input.secret, requester, true)
    const record = await channelStore.create({
      id: newHookId(),
      name: input.name,
      preset: input.preset,
      secret,
      mapping: input.preset === CORE_WEBHOOK_SOURCE ? input.mapping : {},
      created_at: now(),
      secret_pending: pending,
    })
    if (input.subscribe_ea) {
      await channelSubscriptions.add({
        channel_id: record.id,
        target: 'ea',
        task_id: null,
        events: null,
        created_at: now(),
      })
    }
    return { channel: await info(record), secret: shown }
  },
  update: async (id: string, change: z.output<typeof channelUpdateInput>): Promise<WebhookChannelInfo> => {
    const current = await recordOf(id)
    if (change.mapping !== undefined && current.preset !== CORE_WEBHOOK_SOURCE) {
      throw new HttpError(400, 'Only generic webhooks take a field mapping')
    }
    const updated = (await channelStore.update(id, change, now())) ?? current
    if (updated.name !== current.name) {
      signalTasks(await subscribedTasks(id))
    }
    return info(updated)
  },
  rotate: async (id: string, given: string | undefined, requester = USER): Promise<ChannelSecret> => {
    const current = await recordOf(id)
    const { secret, shown, pending } = secretFor(webhookSender(current.preset).sender, given, requester, false)
    const rotated = await channelStore.rotate(id, secret, pending, now())
    return { channel: await info(rotated ?? current), secret: shown }
  },
  /** The secret Seti issued on the EA's request, once, for the user to copy into the sender. */
  reveal: async (id: string): Promise<ChannelSecret> => {
    await recordOf(id)
    const taken = await channelStore.takeReveal(id)
    if (taken === undefined) {
      throw new HttpError(409, 'This secret was shown already; rotate it for a new one')
    }
    if (taken.secret === null) {
      throw new HttpError(409, 'The stored secret does not open with the current key; rotate it')
    }
    return { channel: await info(taken), secret: taken.secret }
  },
  remove: async (id: string): Promise<ChannelRecord> => {
    const current = await recordOf(id)
    const taskIds = await subscribedTasks(id)
    await channelStore.remove(id)
    signalTasks(taskIds)
    return current
  },
  sendTest: async (id: string): Promise<WebhookChannelInfo> => {
    const current = await recordOf(id)
    requireWebhookSource(current.preset)
    const result = await receiver.sendTest(current)
    if (result.status === 'rejected') {
      throw new HttpError(500, `The test delivery was refused: ${result.reason}`)
    }
    return info(current)
  },
}
