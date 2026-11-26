import { adoptWorker } from '@/lib/app-update'

async function register(): Promise<void> {
  adoptWorker(await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }))
}

/** A clicked notification asks an open Seti to show its agent; the hash carries the route. */
function openFromNotification(event: MessageEvent): void {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== 'seti:open') {
    return
  }
  const url = 'url' in data && typeof data.url === 'string' ? new URL(data.url, window.location.origin) : null
  if (url?.origin === window.location.origin && url.hash !== '') {
    window.location.hash = url.hash
  }
}

/** Installs the offline shell worker; app-update.ts moves the page to each new build. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    return
  }
  navigator.serviceWorker.addEventListener('message', openFromNotification)
  window.addEventListener('load', () => {
    // Without a worker Seti still works online; the next page load registers again.
    register().catch(() => undefined)
  })
}
