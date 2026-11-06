import { toast } from 'sonner'

let reloadOnNewController = false

function offerReload(worker: ServiceWorker): void {
  toast('Seti updated', {
    id: 'seti-updated',
    duration: Infinity,
    action: {
      label: 'Reload',
      onClick: () => {
        reloadOnNewController = true
        worker.postMessage('skip-waiting')
      },
    },
  })
}

/** Only a worker that replaces a controlling one is an update; the first install is not. */
function watchInstall(worker: ServiceWorker): void {
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller !== null) {
      offerReload(worker)
    }
  })
}

async function register(): Promise<void> {
  const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadOnNewController) {
      window.location.reload()
    }
  })
  if (registration.waiting !== null && navigator.serviceWorker.controller !== null) {
    offerReload(registration.waiting)
  }
  registration.addEventListener('updatefound', () => {
    if (registration.installing !== null) {
      watchInstall(registration.installing)
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Offline or signed out of Access; the next check tries again.
      registration.update().catch(() => undefined)
    }
  })
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

/** Installs the offline shell worker and offers a reload once a newer build is waiting. */
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
