import type { WebhookChannelInfo, webhookThreadsInput } from '@seti/shared'
import type { z } from 'zod'
import { audit } from '../audit.js'
import { webhooks } from '../channels/service.js'
import { refuseAgent } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { channelThreads } from '../store/thread-replies.js'

/** What only the user changes, as refusals name it. */
export const THREAD_SWITCHES = 'turn thread replies or DM replies on or off'

const onOff = (on: boolean) => (on ? 'on' : 'off')

/** Turns thread or DM replies on or off (THR-6); thread replies on brings DM replies unless told. */
export async function setWebhookThreads(
  id: string,
  change: z.output<typeof webhookThreadsInput>,
): Promise<WebhookChannelInfo> {
  refuseAgent(THREAD_SWITCHES)
  const before = await webhooks.info(id)
  if (before.threads === null) {
    throw new HttpError(400, `Seti reads no replies from ${before.sender.label} webhooks`)
  }
  const withDms = change.replies === true && change.dms === undefined ? { ...change, dms: true } : change
  await channelThreads.set(id, withDms)
  const after = await webhooks.info(id)
  const { replies, dms } = after.threads ?? before.threads
  await audit.record({
    actor: 'user',
    kind: 'system.channel_threads_changed',
    subject_type: 'system',
    subject_id: id,
    summary: `Turned thread replies ${onOff(replies)} and DM replies ${onOff(dms)} on the webhook ${after.name}`,
    detail: { channel: after.name, replies, dms },
  })
  return after
}
