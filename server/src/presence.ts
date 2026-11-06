import type { NotificationFocusInput } from '@seti/shared'
import { AWAY_AFTER_MS } from './config.js'

/** A page reports what it shows every 20 s or so; a report older than this no longer counts. */
export const FOCUS_TTL_MS = 45_000

/** The EA asks for its inbox every 2 s on a call; a call not heard from for this long has ended. */
const CALL_TTL_MS = 15_000

interface Focus {
  agents: ReadonlySet<string>
  active: boolean
  at: number
}

/** What each device's visible Seti page shows, by device id; kept in memory only. */
const focus = new Map<string, Focus>()

let callAt: number | null = null
/** The last time a page had focus or a call was live; the server's start counts as present. */
let presentAt = Date.now()

type ReturnListener = (left: number, at: number) => void
const returnListeners: ReturnListener[] = []

/** Calls the listener when the user comes back after AWAY_AFTER_MS or more, with when they left. */
export function onReturn(listener: ReturnListener): void {
  returnListeners.push(listener)
}

/** A page that keeps focus, or a call that stays live, is presence without a gap between reports. */
function present(at: number, wasHere: boolean): void {
  const left = presentAt
  presentAt = Math.max(presentAt, at)
  if (!wasHere && at - left >= AWAY_AFTER_MS) {
    for (const listener of returnListeners) {
      listener(left, at)
    }
  }
}

export function recordFocus(input: NotificationFocusInput, at = Date.now()): void {
  if (input.agents.length === 0 && !input.active) {
    focus.delete(input.device_id)
    return
  }
  const wasHere = here(at)
  focus.set(input.device_id, { agents: new Set(input.agents), active: input.active, at })
  if (input.active) {
    present(at, wasHere)
  }
}

/** The EA reports a live call with each inbox poll it makes during one. */
export function recordCall(at = Date.now()): void {
  const wasHere = here(at)
  callAt = at
  present(at, wasHere)
}

const fresh = (seen: Focus, at: number) => at - seen.at <= FOCUS_TTL_MS

/** A device whose page shows the agent, or has focus and toasts it, gets no push about it. */
export function onScreen(deviceId: string, taskId: string, at: number): boolean {
  const seen = focus.get(deviceId)
  if (seen === undefined || !fresh(seen, at)) {
    return false
  }
  return seen.active || seen.agents.has(taskId)
}

/** Some device has a Seti page with focus now, so a toast there reaches the user. */
export function pageFocused(at = Date.now()): boolean {
  return [...focus.values()].some((seen) => seen.active && fresh(seen, at))
}

/** The last time a page had focus or a call was live. */
export function lastPresent(): number {
  return presentAt
}

export function callLive(at = Date.now()): boolean {
  return callAt !== null && at - callAt <= CALL_TTL_MS
}

const here = (at: number) => pageFocused(at) || callLive(at)

/** Forgets every report; tests start each case with nobody present. */
export function resetPresence(at = Date.now()): void {
  focus.clear()
  callAt = null
  presentAt = at
}
