import { EA_CALL_NOTICE_TAG, eaCallActionMessage, type EaCallAction } from '@seti/shared'
import { useEffect } from 'react'
import type { EaCallStore } from './call-store'

/** Chrome takes notification buttons, which the DOM types no longer list. */
type CallNoticeOptions = NotificationOptions & { actions: { action: EaCallAction; title: string }[] }

const CALL_NOTICE_TITLE = 'Call with the EA'

/** The notification a live call shows, so a live microphone is never out of sight. */
export function callNotice(micOn: boolean): CallNoticeOptions {
  return {
    tag: EA_CALL_NOTICE_TAG,
    body: micOn ? 'Microphone on' : 'Muted',
    icon: '/icon-192.png',
    badge: '/favicon-64.png',
    silent: true,
    requireInteraction: true,
    data: { url: '/#ea' },
    actions: [
      { action: 'ea-mute', title: micOn ? 'Mute' : 'Unmute' },
      { action: 'ea-hang-up', title: 'Hang up' },
    ],
  }
}

/** Android shows the call as a notification, which its Seti app holds as a call service. */
const shows = () =>
  navigator.userAgent.includes('Android') &&
  'Notification' in window &&
  Notification.permission === 'granted' &&
  'serviceWorker' in navigator

const registration = async () => navigator.serviceWorker.getRegistration().catch(() => undefined)

async function show(micOn: boolean): Promise<void> {
  await (await registration())?.showNotification(CALL_NOTICE_TITLE, callNotice(micOn)).catch(() => undefined)
}

async function close(): Promise<void> {
  const shown = (await (await registration())?.getNotifications({ tag: EA_CALL_NOTICE_TAG })) ?? []
  for (const notice of shown) {
    notice.close()
  }
}

/** Mute and Hang up from the notification, as the service worker reports them. */
function onPress(store: EaCallStore) {
  return (event: MessageEvent) => {
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null || !('action' in data) || typeof data.action !== 'string') {
      return
    }
    const message = eaCallActionMessage(EA_CALL_NOTICE_TAG, data.action)
    if (message?.action === 'ea-hang-up') {
      void store.hangUp()
    } else if (message?.action === 'ea-mute') {
      store.setMic(!store.getSnapshot().micOn)
    }
  }
}

/** Shows a live call as a notification with Mute and Hang up on Android, and removes it after. */
export function useCallNotice(store: EaCallStore, connected: boolean, micOn: boolean): void {
  useEffect(() => {
    if (connected && shows()) {
      void show(micOn)
    }
  }, [connected, micOn])
  useEffect(() => {
    if (!connected || !shows()) {
      return undefined
    }
    const press = onPress(store)
    navigator.serviceWorker.addEventListener('message', press)
    return () => {
      navigator.serviceWorker.removeEventListener('message', press)
      void close()
    }
  }, [store, connected])
}
