import type { Page, Request } from '@playwright/test'
import type { EaCallEndInput } from '@seti/shared'

type HeldWindow = Window & {
  timersHeld?: boolean
  mediaActions?: Record<string, MediaSessionActionHandler | null>
  micTracks?: MediaStreamTrack[]
  launchConsumer?: (params: { targetURL?: string }) => void
}

/** Lets a test hold the page's interval timers, as Chrome throttles them in a background page. */
function installHold(): void {
  const original = window.setInterval.bind(window)
  window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    original(() => {
      if ((window as HeldWindow).timersHeld !== true && typeof handler === 'function') {
        ;(handler as (...rest: unknown[]) => void)(...args)
      }
    }, ms)) as typeof window.setInterval
  const actions: Record<string, MediaSessionActionHandler | null> = {}
  ;(window as HeldWindow).mediaActions = actions
  const set = Reflect.get<MediaSession, 'setActionHandler'>(MediaSession.prototype, 'setActionHandler')
  MediaSession.prototype.setActionHandler = function (action, handler) {
    actions[action] = handler
    set.call(this, action, handler)
  }
}

/** Keeps each microphone track the page opens, and takes the Launch Handler consumer it sets. */
function installPhoneHooks(): void {
  const held = window as HeldWindow
  held.micTracks = []
  const media = navigator.mediaDevices
  const open = media.getUserMedia.bind(media)
  media.getUserMedia = async (request) => {
    const stream = await open(request)
    held.micTracks?.push(...stream.getAudioTracks())
    return stream
  }
  Object.defineProperty(window, 'launchQueue', {
    configurable: true,
    value: {
      setConsumer: (consumer: (params: { targetURL?: string }) => void) => {
        held.launchConsumer = consumer
      },
    },
  })
}

/** Lets a test open Seti again from a link and drop the microphone, as a phone can. */
export async function phoneHooks(page: Page): Promise<void> {
  await page.addInitScript(installPhoneHooks)
}

/** Opens Seti at `url` while it runs, as the app icon or a widget does with a running app. */
export async function launch(page: Page, url: string): Promise<void> {
  await page.evaluate((targetURL) => {
    ;(window as HeldWindow).launchConsumer?.({ targetURL })
  }, url)
}

/** Ends the newest microphone track, as iOS does to a page in the background. */
export async function dropMic(page: Page): Promise<number> {
  return page.evaluate(() => {
    const tracks = (window as HeldWindow).micTracks ?? []
    tracks.at(-1)?.stop()
    return tracks.length
  })
}

/** How many microphone tracks the page has opened, and whether the newest is live. */
export async function micTracks(page: Page): Promise<{ count: number; live: boolean }> {
  return page.evaluate(() => {
    const tracks = (window as HeldWindow).micTracks ?? []
    return { count: tracks.length, live: tracks.at(-1)?.readyState === 'live' }
  })
}

/** Records the media controls the page sets and lets the test hold its interval timers. */
export async function backgroundable(page: Page): Promise<void> {
  await page.addInitScript(installHold)
}

/** Sends the page to the background as switching apps does, with its interval timers held. */
export async function toBackground(page: Page, hidden = true): Promise<void> {
  await page.evaluate((away) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (away ? 'hidden' : 'visible') })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => away })
    ;(window as HeldWindow).timersHeld = away
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

/** Presses a media control, as the lock screen or a headset button would. */
export async function pressMediaAction(page: Page, action: string): Promise<void> {
  await page.evaluate((name) => {
    ;(window as HeldWindow).mediaActions?.[name]?.({ action: name as MediaSessionAction })
  }, action)
}

export async function mediaSession(page: Page): Promise<{ title: string | null; state: string }> {
  return page.evaluate(() => ({
    title: navigator.mediaSession.metadata?.title ?? null,
    state: navigator.mediaSession.playbackState,
  }))
}

/** Collects every call end the page reports. */
export function callEnds(page: Page): EaCallEndInput[] {
  const ends: EaCallEndInput[] = []
  page.on('request', (request: Request) => {
    if (request.url().endsWith('/api/ea/call-end')) {
      ends.push(request.postDataJSON() as EaCallEndInput)
    }
  })
  return ends
}

/** The longest wait between pings since `from`, counting the wait from `from` to the first. */
export function longestGap(pings: readonly number[], from: number, to: number): number {
  const times = [from, ...pings.filter((at) => at > from && at <= to), to]
  return Math.max(...times.slice(1).map((at, i) => at - (times[i] ?? at)))
}

type NoticeWindow = Window & { notices?: Map<string, { title: string; body: string }> }

/** Stands in for notifications, which headless Chromium always refuses. */
function installNotices(): void {
  const notices = new Map<string, { title: string; body: string }>()
  ;(window as NoticeWindow).notices = notices
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' })
  const registration = {
    showNotification: async (title: string, options: NotificationOptions = {}) => {
      notices.set(options.tag ?? '', { title, body: options.body ?? '' })
      return Promise.resolve()
    },
    getNotifications: async ({ tag = '' }: GetNotificationOptions = {}) =>
      Promise.resolve(
        [...notices.entries()].filter(([key]) => key === tag).map(([key]) => ({ close: () => notices.delete(key) })),
      ),
  }
  navigator.serviceWorker.getRegistration = async () =>
    Promise.resolve(registration as unknown as ServiceWorkerRegistration)
}

/** Lets the page show notifications, kept in a list the test reads. */
export async function notifications(page: Page): Promise<void> {
  await page.addInitScript(installNotices)
}

export async function shownNotices(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...((window as NoticeWindow).notices?.values() ?? [])].map((notice) => `${notice.title}: ${notice.body}`),
  )
}

/** Presses a button on the call's notification, as the service worker reports it to the page. */
export async function pressNotice(page: Page, action: string): Promise<void> {
  await page.evaluate((name) => {
    const data = { type: 'seti:ea-call', action: name }
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data }))
  }, action)
}
