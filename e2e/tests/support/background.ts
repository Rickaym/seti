import type { Page, Request } from '@playwright/test'
import type { EaCallEndInput } from '@seti/shared'

type HeldWindow = Window & {
  timersHeld?: boolean
  mediaActions?: Record<string, MediaSessionActionHandler | null>
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
