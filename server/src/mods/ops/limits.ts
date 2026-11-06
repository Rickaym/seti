import { MOD_LIMITS } from '@seti/shared'
import { HttpError } from '../../http.js'
import { rateLimiter } from '../../rate-limit.js'
import type { ModCall } from '../capabilities.js'

const HOUR_MS = 60 * 60_000
/** Long enough to outlast any one event, whose id never repeats. */
const EVENT_WINDOW_MS = 2 * MOD_LIMITS.scheduleWallMs

interface Cap {
  /** What the limit counts, as the refusal names it. */
  label: string
  perEvent: ReturnType<typeof rateLimiter>
  perHour: ReturnType<typeof rateLimiter>
}

const cap = (label: string, perEvent: number, perHour: number): Cap => ({
  label,
  perEvent: rateLimiter(perEvent, EVENT_WINDOW_MS),
  perHour: rateLimiter(perHour, HOUR_MS),
})

/** What a mod may send per event and per hour, so no mod floods the chat or the user's phone. */
const CAPS = {
  chat: cap('posts', MOD_LIMITS.chatPerEvent, MOD_LIMITS.chatPerHour),
  notify: cap('notifications', MOD_LIMITS.notifyPerEvent, MOD_LIMITS.notifyPerHour),
} as const

/** Counts one send against the mod's caps; a call outside an event counts only per hour. */
export function takeSend(call: ModCall, kind: keyof typeof CAPS): void {
  const { label, perEvent, perHour } = CAPS[kind]
  const event = call.eventId === null ? null : `${call.modId}\n${call.eventId}`
  if (event !== null && perEvent.full(event)) {
    throw new HttpError(429, `${call.modId} sent its ${label} for this event already`)
  }
  if (!perHour.take(call.modId)) {
    throw new HttpError(429, `${call.modId} sent its ${label} for this hour already`)
  }
  if (event !== null) {
    perEvent.take(event)
  }
}
