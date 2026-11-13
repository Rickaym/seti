import type { AttentionRoute, AttentionTier, EaInboxItem } from '@seti/shared'
import { callLive, lastPresent, pageFocused } from './presence.js'
import { agentWaits } from './store/agent-waits.js'
import { eaWatches } from './store/inbox.js'
import { notificationSettings, pushDevices } from './store/notifications.js'

/** At most this many pushes in the window while the user is away; below urgent, more wait. */
export const BURST_CAP = 5
const BURST_WINDOW_MS = 10 * 60 * 1000

/** When each recent push went out; toasts fold on the page and a call waits for its pauses. */
let pushes: number[] = []

/** Pushes since the user was last here, within the window; coming back starts the count over. */
function recent(at: number): number {
  const since = Math.max(at - BURST_WINDOW_MS, lastPresent())
  pushes = pushes.filter((when) => when >= since)
  return pushes.length
}

export interface AttentionEvent {
  tier: AttentionTier
  /** An agent waits on the user; such an event is urgent whatever its tier. */
  needsYou?: boolean
  /** The EA's inbox carries it, so a live call can speak it and Seti raises its toast. */
  viaEa: boolean
  /** The EA takes it on a live call; an item Seti posts while no call runs passes false. */
  callable?: boolean
}

const anyPushDevice = async () => (await pushDevices.list()).length > 0

/** The surface a tier uses while the user is here: the call, else a page with focus. */
function hereRoute(event: AttentionEvent, at: number): AttentionRoute | null {
  if (event.viaEa && event.callable !== false && callLive(at)) {
    return 'call'
  }
  return pageFocused(at) ? 'toast' : null
}

/**
 * The one surface that carries the event. Needs-you is always urgent and never capped; below
 * urgent, a burst past BURST_CAP pushes in BURST_WINDOW_MS of one absence waits for the brief.
 * Away with no push device, the event waits for the brief.
 */
export async function routeAttention(event: AttentionEvent, at = Date.now()): Promise<AttentionRoute> {
  const tier: AttentionTier = event.needsYou === true ? 'urgent' : event.tier
  const surface = (await notificationSettings.get())[tier]
  if (surface === 'off') {
    return 'passive'
  }
  if (surface === 'brief' || (tier !== 'urgent' && recent(at) >= BURST_CAP)) {
    return 'digest'
  }
  const route = hereRoute(event, at) ?? (surface === 'push' && (await anyPushDevice()) ? 'push' : 'digest')
  if (route === 'push') {
    pushes.push(at)
  }
  return route
}

/** Watch events that only record a link; the EA knows them, nothing shows. */
const PASSIVE_EVENTS = new Set(['pr_linked'])
/** Watch events worth a notice, though the agent works on. */
const ACTIVE_EVENTS = new Set(['model_fallback'])

/**
 * The tier of an inbox item. Urgent items stay urgent; a watched agent's routine news is digest;
 * what is addressed to the EA or the user, such as a reminder, a mention, an alert or a switch
 * to a fallback model, is active.
 */
export function tierOfItem(item: Pick<EaInboxItem, 'kind' | 'event' | 'urgent'>): AttentionTier {
  if (item.urgent) {
    return 'urgent'
  }
  if (item.kind !== 'watch_event' || ACTIVE_EVENTS.has(item.event)) {
    return 'active'
  }
  return PASSIVE_EVENTS.has(item.event) ? 'passive' : 'digest'
}

/** Agents the EA watches or waits for: its inbox item about them is their one surface. */
export async function eaTaskIds(): Promise<string[]> {
  const [watches, waits] = await Promise.all([eaWatches.list(), agentWaits.eaTargets()])
  return [...new Set([...watches.map((watch) => watch.task_id), ...waits])]
}

export async function eaCarries(taskId: string): Promise<boolean> {
  return (await eaWatches.get(taskId)) !== undefined || agentWaits.eaWaits(taskId)
}

/** Forgets recent pushes; tests start each case with none. */
export function resetAttention(): void {
  pushes = []
}
