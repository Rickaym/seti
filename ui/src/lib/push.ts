import type { NotificationStatus, PushDeviceInput } from '@seti/shared'
import { apiDelete, apiPut } from '@/api'
import { deviceId, deviceLabel } from '@/lib/device'
import { needsHomeScreen } from '@/lib/ios'

/** Why this browser cannot take push notifications, or null when it can ask for them. */
export type PushBlocker = 'unsupported' | 'ios-browser' | 'denied'

const READY_TIMEOUT_MS = 10_000

export function pushBlocker(): PushBlocker | null {
  if (needsHomeScreen()) {
    return 'ios-browser'
  }
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (!supported) {
    return 'unsupported'
  }
  return Notification.permission === 'denied' ? 'denied' : null
}

/** This browser's push service subscription, through the service worker that shows the pushes. */
async function registration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error('The Seti service worker is not running; reload and try again'))
    }, READY_TIMEOUT_MS)
  })
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey
  if (key === null) {
    return false
  }
  const ours = keyBytes(publicKey)
  const theirs = new Uint8Array(key)
  return theirs.length === ours.length && theirs.every((byte, index) => byte === ours[index])
}

function deviceInput(subscription: PushSubscription): PushDeviceInput {
  const json = subscription.toJSON()
  return {
    subscription: {
      endpoint: subscription.endpoint,
      keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    },
    label: deviceLabel(navigator.userAgent),
  }
}

/** Asks for permission, subscribes with Seti's key and saves the subscription for this device. */
export async function enablePush(publicKey: string): Promise<NotificationStatus> {
  // Safari asks only within the tap, so nothing may be awaited before this.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notifications are blocked for Seti in this browser')
  }
  const { pushManager } = await registration()
  const existing = await pushManager.getSubscription()
  if (existing !== null && !sameKey(existing, publicKey)) {
    await existing.unsubscribe()
  }
  const subscription =
    existing !== null && sameKey(existing, publicKey)
      ? existing
      : await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  return apiPut<NotificationStatus>(`/notifications/devices/${deviceId()}`, deviceInput(subscription))
}

/** Forgets this device on the server and drops the browser's subscription. */
export async function disablePush(): Promise<void> {
  await apiDelete(`/notifications/devices/${deviceId()}`)
  if ('serviceWorker' in navigator) {
    const current = await navigator.serviceWorker.getRegistration()
    await (await current?.pushManager.getSubscription())?.unsubscribe()
  }
}
