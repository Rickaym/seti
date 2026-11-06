import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  agentUrl,
  ATTENTION_TIERS,
  needsYou,
  NO_CLOSING_LINE,
  VAPID_KEYS_SECRET,
  type AgentNotifyKind,
  type EaInboxItem,
  type NotificationPayload,
  type NotificationSettings,
  type NotificationStatus,
  type PushDeviceInput,
  type Task,
  type TaskEvent,
  type TaskStatus,
  type TestNotificationResult,
} from '@seti/shared'
import type * as WebPush from 'web-push'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { firstLine } from './closing-line.js'
import { PUBLIC_ACCESS, PUSH_LOOPBACK } from './config.js'
import { tasks } from './db.js'
import { eaCarries, routeAttention } from './ea-attention.js'
import { HttpError } from './http.js'
import { needsYouCount } from './needs-you-count.js'
import { onScreen } from './presence.js'
import { sealedSecrets, secret, SecretUnreadableError } from './secrets.js'
import { notificationSettings, pushDevices, type PushTarget } from './store/notifications.js'
import { attentionOf, lastResult } from './task-attention.js'

/** web-push is CommonJS whose exports Node's ESM loader cannot name, so it loads through require. */
const webPush = createRequire(import.meta.url)('web-push') as typeof WebPush

/** Push services of the browsers Seti runs in; a subscription elsewhere is refused. */
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com']

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const SEND_TIMEOUT_MS = 10_000
/** How long a push service keeps a notification for a device that is offline. */
const TURN_TTL_S = 12 * 60 * 60
const TEST_TTL_S = 60
const SUBJECT = PUBLIC_ACCESS?.origin ?? 'mailto:seti@localhost'

interface VapidKeys {
  publicKey: string
  privateKey: string
}

let keys: VapidKeys | null = null

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function readKeys(text: string): VapidKeys {
  const parsed: unknown = JSON.parse(text)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('publicKey' in parsed) ||
    !('privateKey' in parsed) ||
    typeof parsed.publicKey !== 'string' ||
    typeof parsed.privateKey !== 'string'
  ) {
    throw new Error('The stored push keys are not a key pair')
  }
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
}

/** The sealed key pair; one a new store key cannot open is dropped, so Seti makes another. */
async function storedKeys(): Promise<string | null> {
  try {
    return await secret(VAPID_KEYS_SECRET)
  } catch (e) {
    if (!(e instanceof SecretUnreadableError)) {
      throw e
    }
    process.stderr.write('notifications: the push keys no longer open; making a new pair\n')
    await sealedSecrets.remove(VAPID_KEYS_SECRET)
    return null
  }
}

/** The push key pair, made and sealed in the secret store the first time it is needed. */
async function vapidKeys(): Promise<VapidKeys> {
  if (keys !== null) {
    return keys
  }
  const stored = await storedKeys()
  if (stored !== null) {
    keys = readKeys(stored)
    return keys
  }
  const made = webPush.generateVAPIDKeys()
  const saved = await sealedSecrets.putIfAbsent(VAPID_KEYS_SECRET, JSON.stringify(made))
  keys = saved ? made : readKeys((await secret(VAPID_KEYS_SECRET)) ?? '')
  return keys
}

/** Makes the push keys at startup, so the first device need not wait; push stays off on failure. */
export async function preparePush(): Promise<void> {
  try {
    await vapidKeys()
  } catch (e) {
    process.stderr.write(`notifications: push is off: ${errorText(e)}\n`)
  }
}

async function publicKey(): Promise<string | null> {
  try {
    return (await vapidKeys()).publicKey
  } catch {
    return null
  }
}

/** Why Seti refuses to push to the endpoint, or null when it is a known push service. */
function endpointProblem(endpoint: string): string | null {
  const url = new URL(endpoint)
  if (PUSH_LOOPBACK && LOOPBACK_HOSTS.has(url.hostname)) {
    return null
  }
  if (url.protocol !== 'https:') {
    return 'A push endpoint must be https'
  }
  const host = url.hostname.toLowerCase()
  const known = PUSH_HOSTS.some((service) => host === service || host.endsWith(`.${service}`))
  return known ? null : `${host} is not a push service Seti sends to`
}

interface Delivery {
  ttl: number
  urgency: WebPush.Urgency
  topic: string
}

/** A push service topic: at most 32 URL-safe characters, so a UUID loses its hyphens. */
function topicOf(id: string): string {
  const plain = id.replace(/[^A-Za-z0-9]/g, '')
  return plain.length <= 32 ? plain : createHash('sha256').update(id).digest('base64url').slice(0, 32)
}

function request(target: PushTarget, payload: NotificationPayload, pair: VapidKeys, delivery: Delivery) {
  return webPush.generateRequestDetails(target, JSON.stringify(payload), {
    vapidDetails: { subject: SUBJECT, publicKey: pair.publicKey, privateKey: pair.privateKey },
    TTL: delivery.ttl,
    urgency: delivery.urgency,
    topic: delivery.topic,
    contentEncoding: 'aes128gcm',
  })
}

/** Sends one push; a subscription the service no longer knows is dropped. True when it went out. */
async function deliver(target: PushTarget, payload: NotificationPayload, delivery: Delivery): Promise<boolean> {
  try {
    const details = request(target, payload, await vapidKeys(), delivery)
    const res = await fetch(details.endpoint, {
      method: 'POST',
      headers: details.headers,
      body: new Uint8Array(details.body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    if (res.status === 404 || res.status === 410) {
      await pushDevices.removeEndpoint(target.device_id, target.endpoint)
      return false
    }
    if (!res.ok) {
      process.stderr.write(`notifications: the push service answered ${String(res.status)}\n`)
    }
    return res.ok
  } catch (e) {
    process.stderr.write(`notifications: a push failed: ${errorText(e)}\n`)
    return false
  }
}

/** The line a push about the agent reads; the widget shows the same reason line. */
export async function notifyBody(task: Task, kind: AgentNotifyKind): Promise<string> {
  if (kind === 'finished') {
    return task.closing_line ?? NO_CLOSING_LINE
  }
  if (task.blocked !== null) {
    return firstLine(task.blocked)
  }
  if (task.asking) {
    const question = firstLine((await lastResult(task.id)).split(/\n\s*\n/).at(-1) ?? '')
    return question === '' ? 'Asks you' : `Asks: ${question}`
  }
  if (task.status === 'error') {
    const cause = firstLine(task.last_error ?? '')
    return cause === '' ? 'Failed' : `Failed: ${cause}`
  }
  return task.status === 'interrupted' ? 'Cut off by a restart' : 'Needs you'
}

/** The last state each agent notified about, so the status event and turn end of one send once. */
const notified = new Map<string, string>()
const NOTIFIED_KEPT = 500

function firstTime(task: Task, kind: AgentNotifyKind): boolean {
  const key = `${kind}@${task.updated_at}`
  if (notified.get(task.id) === key) {
    return false
  }
  notified.delete(task.id)
  notified.set(task.id, key)
  for (const old of notified.keys()) {
    if (notified.size <= NOTIFIED_KEPT) {
      break
    }
    notified.delete(old)
  }
  return true
}

/**
 * Pushes the agent's news to every device that does not show it now, when the attention router
 * picks a push: the EA's item carries an agent it watches, and a page with focus raises a toast.
 * Returns how many devices got it.
 */
export async function notifyAgent(task: Task, kind: AgentNotifyKind, at = Date.now()): Promise<number> {
  if (task.notifications_muted || task.archived_at !== null || !firstTime(task, kind)) {
    return 0
  }
  if (await eaCarries(task.id)) {
    return 0
  }
  const route = await routeAttention({ tier: 'active', needsYou: kind === 'needs_you', viaEa: false }, at)
  if (route !== 'push') {
    return 0
  }
  const targets = (await pushDevices.targets()).filter((target) => !onScreen(target.device_id, task.id, at))
  if (targets.length === 0) {
    return 0
  }
  const payload: NotificationPayload = {
    title: task.title,
    body: await notifyBody(task, kind),
    tag: task.id,
    url: agentUrl(task.id),
    kind,
    badge: await needsYouCount(),
  }
  const delivery: Delivery = {
    ttl: TURN_TTL_S,
    urgency: kind === 'needs_you' ? 'high' : 'normal',
    topic: topicOf(task.id),
  }
  const sent = await Promise.all(targets.map(async (target) => deliver(target, payload, delivery)))
  return sent.filter(Boolean).length
}

async function notifyStatus(taskId: string, status: TaskStatus): Promise<void> {
  const task = await tasks.get(taskId)
  const kind = task === undefined ? null : await attentionOf(task, status)
  if (task !== undefined && kind !== null) {
    await notifyAgent(task, kind)
  }
}

/** Turn-end listener: tells devices the turn finished, or that the agent needs the user. */
export function notifyTurnEnd(taskId: string, status: TaskStatus): void {
  inBackground('notifications', async () => notifyStatus(taskId, status))
}

/** Pushes a blocked agent's reason; one push per reason, as the task's update time marks it. */
async function notifyBlocked(taskId: string): Promise<void> {
  const task = await tasks.get(taskId)
  if (task !== undefined && task.blocked !== null) {
    await notifyAgent(task, 'needs_you')
  }
}

/**
 * Task event listener: a status that needs the user notifies at once, even within a turn, as does
 * a new reason the agent waits on the user, such as a permission request.
 */
export function notifyStatusEvent(taskId: string, event: TaskEvent): void {
  if (event.type === 'status' && needsYou(event.status)) {
    inBackground('notifications', async () => notifyStatus(taskId, event.status))
  } else if (event.type === 'blocked' && event.blocked !== null) {
    inBackground('notifications', async () => notifyBlocked(taskId))
  }
}

/** Agents a restart cut off need the user; startup tells the devices. */
export function notifyInterrupted(taskIds: readonly string[]): void {
  for (const id of taskIds) {
    notifyTurnEnd(id, 'interrupted')
  }
}

export async function notificationStatus(): Promise<NotificationStatus> {
  const [key, settings, devices] = await Promise.all([publicKey(), notificationSettings.get(), pushDevices.list()])
  return { public_key: key, settings, devices }
}

export async function changeNotificationSettings(change: Partial<NotificationSettings>): Promise<NotificationStatus> {
  const before = await notificationSettings.get()
  const next: NotificationSettings = { ...before, ...change }
  if (ATTENTION_TIERS.some((tier) => next[tier] !== before[tier])) {
    await notificationSettings.set(next)
    const tiers = ATTENTION_TIERS.map((tier) => `${tier} ${next[tier]}`).join(', ')
    await audit.record({
      actor: 'user',
      kind: 'system.notifications_changed',
      subject_type: 'system',
      summary: `Notifications: ${tiers}`,
      detail: { ...next },
    })
  }
  return notificationStatus()
}

/** Saves a device's subscription after checking Seti can encrypt to it and may reach it. */
export async function savePushDevice(deviceId: string, input: PushDeviceInput): Promise<NotificationStatus> {
  const problem = endpointProblem(input.subscription.endpoint)
  if (problem !== null) {
    throw new HttpError(400, problem)
  }
  const target: PushTarget = { device_id: deviceId, ...input.subscription }
  let pair: VapidKeys
  try {
    pair = await vapidKeys()
  } catch (e) {
    throw new HttpError(409, `Seti cannot send push notifications: ${errorText(e)}`)
  }
  try {
    request(target, { title: '', body: '', tag: '', url: '/', kind: 'test' }, pair, {
      ttl: TEST_TTL_S,
      urgency: 'normal',
      topic: 'check',
    })
  } catch (e) {
    throw new HttpError(400, `The subscription keys do not work: ${errorText(e)}`)
  }
  await pushDevices.put({ ...target, label: input.label })
  await audit.record({
    actor: 'user',
    kind: 'system.notifications_changed',
    subject_type: 'system',
    summary: `Push notifications on for ${input.label}`,
    detail: { device: input.label },
  })
  return notificationStatus()
}

export async function removePushDevice(deviceId: string): Promise<void> {
  const label = await pushDevices.remove(deviceId)
  if (label === null) {
    throw new HttpError(404, 'That device gets no push notifications')
  }
  await audit.record({
    actor: 'user',
    kind: 'system.notifications_changed',
    subject_type: 'system',
    summary: `Push notifications off for ${label}`,
    detail: { device: label },
  })
}

/** Pushes a test to one device, or to all; it skips mutes, settings and what pages show. */
export async function sendTestNotification(deviceId?: string): Promise<TestNotificationResult> {
  if ((await publicKey()) === null) {
    throw new HttpError(409, 'Seti cannot send push notifications without its secret key')
  }
  const targets = (await pushDevices.targets()).filter(
    (target) => deviceId === undefined || target.device_id === deviceId,
  )
  if (targets.length === 0) {
    throw new HttpError(404, deviceId === undefined ? 'No device gets notifications yet' : 'Turn on push first')
  }
  const payload: NotificationPayload = {
    title: 'Seti',
    body: 'Notifications work on this device',
    tag: 'seti-test',
    url: '/#settings/notifications',
    kind: 'test',
  }
  const delivery: Delivery = { ttl: TEST_TTL_S, urgency: 'high', topic: 'seti-test' }
  const sent = (await Promise.all(targets.map(async (target) => deliver(target, payload, delivery)))).filter(Boolean)
  return { sent: sent.length, failed: targets.length - sent.length }
}

/** Pushes an EA item the attention router sent to the phone, in its notice's own words. */
export async function pushEaItem(item: EaInboxItem, at = Date.now()): Promise<number> {
  const taskId = item.task_id
  const targets = (await pushDevices.targets()).filter(
    (target) => taskId === null || !onScreen(target.device_id, taskId, at),
  )
  const payload: NotificationPayload = {
    title: item.source,
    body: item.title,
    tag: taskId ?? `ea-${String(item.id)}`,
    url: taskId === null ? '/#ea' : agentUrl(taskId),
    kind: 'ea',
    badge: await needsYouCount(),
  }
  const delivery: Delivery = {
    ttl: TURN_TTL_S,
    urgency: item.urgent ? 'high' : 'normal',
    topic: topicOf(payload.tag),
  }
  const sent = await Promise.all(targets.map(async (target) => deliver(target, payload, delivery)))
  return sent.filter(Boolean).length
}

/** Pushes a mod's notification to every device; the mod host checked its kind is on. */
export async function pushToEveryDevice(payload: NotificationPayload): Promise<number> {
  const delivery: Delivery = { ttl: TURN_TTL_S, urgency: 'normal', topic: topicOf(payload.tag) }
  const targets = await pushDevices.targets()
  return (await Promise.all(targets.map(async (target) => deliver(target, payload, delivery)))).filter(Boolean).length
}

/** Mutes or unmutes an agent's notifications for every device. */
export async function setTaskNotificationsMuted(task: Task, muted: boolean): Promise<void> {
  if (task.notifications_muted === muted) {
    return
  }
  await tasks.setNotificationsMuted(task.id, muted)
  await audit.record({
    actor: 'user',
    kind: 'task.notifications_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `${muted ? 'Muted' : 'Unmuted'} notifications of task "${task.title}"`,
    detail: { title: task.title, muted },
  })
}
