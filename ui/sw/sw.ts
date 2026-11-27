import { SHARE_TARGET_PATH } from '@seti/shared/attachment-limits'
import { EA_CALL_NOTICE_TAG, eaCallActionMessage } from '@seti/shared/ea-call-notice'
import { fitsKind, isHashed, passesThrough, planPrecache, type Precache } from './precache'
import { receiveShare } from './share-inbox'

declare const self: ServiceWorkerGlobalScope

/** The build replaces the placeholder with the built files and a hash of their contents. */
const PRECACHE = JSON.parse('__SETI_PRECACHE__') as Precache

const PREFIX = 'seti-shell-'
const CACHE = `${PREFIX}${PRECACHE.version}`
const SHELL = '/index.html'
const PRECACHED = new Set(PRECACHE.urls)

/** Chromium exposes the data saver setting to workers; other engines leave it out. */
interface DataSaver {
  connection?: { saveData?: boolean }
}

const savesData = () => (self.navigator as WorkerNavigator & DataSaver).connection?.saveData === true

/** Maps each path a Seti cache holds, this build's own included, to that cache's name. */
async function heldPaths(): Promise<Map<string, string>> {
  const held = new Map<string, string>()
  for (const name of (await caches.keys()).filter((cacheName) => cacheName.startsWith(PREFIX))) {
    const cache = await caches.open(name)
    for (const request of await cache.keys()) {
      held.set(new URL(request.url).pathname, name)
    }
  }
  return held
}

async function fetchFresh(url: string): Promise<Response> {
  const response = await fetch(new Request(url, { cache: 'reload' }))
  if (!response.ok || !fitsKind(url, response.headers.get('content-type'))) {
    throw new Error(
      `Precache got ${String(response.status)} ${String(response.headers.get('content-type'))} for ${url}`,
    )
  }
  return response
}

async function copyOrFetch(url: string, cacheName: string): Promise<Response> {
  return (await caches.match(url, { cacheName })) ?? fetchFresh(url)
}

/** Gathers every file before writing any, so a failed fetch fails the install and leaves no trace. */
async function precache(): Promise<void> {
  const plan = planPrecache(PRECACHE, await heldPaths(), savesData())
  const entries = await Promise.all([
    ...plan.copy.map(async ([url, cacheName]) => [url, await copyOrFetch(url, cacheName)] as const),
    ...plan.fetch.map(async (url) => [url, await fetchFresh(url)] as const),
  ])
  const cache = await caches.open(CACHE)
  await Promise.all(entries.map(async ([url, response]) => cache.put(url, response)))
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const stale = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== CACHE)
      await Promise.all(stale.map(async (name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') {
    void self.skipWaiting()
  } else if (event.data === 'build') {
    event.ports[0]?.postMessage(PRECACHE.version)
  }
})

/** What a proxy answers while Seti restarts; the page then starts offline and updates later. */
const RESTARTING = new Set([502, 503, 504])

/** The network answers first, redirects to the Access login included; the shell covers offline. */
async function navigate(request: Request): Promise<Response> {
  let response: Response
  try {
    response = await fetch(request)
  } catch (error) {
    const shell = await caches.match(SHELL, { cacheName: CACHE })
    if (shell === undefined) {
      throw error
    }
    return shell
  }
  if (!RESTARTING.has(response.status)) {
    return response
  }
  return (await caches.match(SHELL, { cacheName: CACHE })) ?? response
}

async function precached(request: Request): Promise<Response> {
  return (await caches.match(request, { cacheName: CACHE })) ?? fetch(request)
}

/** Stores into this worker's cache only while it exists, so a replaced worker never revives it. */
async function keep(request: Request, response: Response): Promise<void> {
  if (await caches.has(CACHE)) {
    await (await caches.open(CACHE)).put(request, response)
  }
}

/** Hashed files never change, so the first full response of the right kind is kept for good. */
async function hashedAsset(event: FetchEvent): Promise<Response> {
  const cached = await caches.match(event.request, { cacheName: CACHE })
  if (cached !== undefined) {
    return cached
  }
  const response = await fetch(event.request)
  if (response.status === 200 && fitsKind(new URL(event.request.url).pathname, response.headers.get('content-type'))) {
    const copy = response.clone()
    event.waitUntil(keep(event.request, copy))
  }
  return response
}

interface Notice {
  title: string
  body: string
  tag: string
  url: string
  badge: number | null
}

const text = (value: unknown, fallback: string) => (typeof value === 'string' && value !== '' ? value : fallback)

/** Reads a push from Seti; a payload that does not parse still shows, as Seti. */
function readNotice(data: PushMessageData | null): Notice {
  let parsed: unknown = null
  try {
    parsed = data?.json()
  } catch {
    parsed = null
  }
  const fields = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const url = text(fields.url, '/')
  return {
    title: text(fields.title, 'Seti'),
    body: text(fields.body, ''),
    tag: text(fields.tag, 'seti'),
    url: url.startsWith('/') ? url : '/',
    badge: typeof fields.badge === 'number' && fields.badge >= 0 ? Math.floor(fields.badge) : null,
  }
}

/** Sets the app icon's count where the Badging API exists; iOS needs notifications allowed. */
async function setBadge(count: number | null): Promise<void> {
  if (count === null || !('setAppBadge' in self.navigator)) {
    return
  }
  await (count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge()).catch(() => undefined)
}

self.addEventListener('push', (event) => {
  const notice = readNotice(event.data)
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(notice.title, {
        body: notice.body,
        tag: notice.tag,
        icon: '/icon-192.png',
        badge: '/favicon-64.png',
        data: { url: notice.url },
      }),
      setBadge(notice.badge),
    ]),
  )
})

/** Focuses an open Seti and has it show the agent, or opens Seti there. */
async function openSeti(url: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
  if (open === undefined) {
    await self.clients.openWindow(url)
    return
  }
  open.postMessage({ type: 'seti:open', url })
  try {
    await open.focus()
  } catch {
    await self.clients.openWindow(url)
  }
}

/** Hands a press on the live call's notification to every open Seti; the call stays shown. */
async function pressCall(tag: string, action: string): Promise<void> {
  const message = eaCallActionMessage(tag, action)
  if (message === null) {
    await openSeti('/#ea')
    return
  }
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of windows) {
    client.postMessage(message)
  }
}

self.addEventListener('notificationclick', (event) => {
  if (event.notification.tag === EA_CALL_NOTICE_TAG) {
    event.waitUntil(pressCall(event.notification.tag, event.action))
    return
  }
  event.notification.close()
  const data: unknown = event.notification.data
  const url = typeof data === 'object' && data !== null && 'url' in data ? text(data.url, '/') : '/'
  event.waitUntil(openSeti(url.startsWith('/') ? url : '/'))
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === SHARE_TARGET_PATH) {
    event.respondWith(receiveShare(request, caches, crypto.randomUUID()))
    return
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin || passesThrough(url.pathname)) {
    return
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
  } else if (isHashed(url.pathname)) {
    event.respondWith(hashedAsset(event))
  } else if (PRECACHED.has(url.pathname)) {
    event.respondWith(precached(request))
  }
})
