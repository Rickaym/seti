import type { AttentionRoute, AttentionTier, EaInboxItem } from '@seti/shared'
import { audienceOf, type Audience } from './notify-scope.js'
import { lastPresent, pageFocused } from './presence.js'
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
  /** The workspace of the agent it is about, so only devices that hear about it carry it. */
  workspaceId?: string
}

const anyPushDevice = async (hears: Audience) => (await pushDevices.list()).some((device) => hears(device.device_id))

/**
 * The one surface that carries the event: a toast on a focused page that hears it, else a push.
 * Needs-you is always urgent and never capped, and an urgent event nobody can see as a toast is
 * pushed even when the urgent tier is set to toast. Below urgent, a burst past BURST_CAP pushes
 * in BURST_WINDOW_MS of one absence waits for the brief. With no push device that hears it, the
 * event waits for the brief. An event about an agent counts only the devices that hear about
 * its workspace, so a device kept to another workspace stays quiet. A live call is the EA's own
 * choice when it delivers an item by voice, never the router's.
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
  const hears = await audienceOf(event.workspaceId ?? null)
  if (pageFocused(at, hears)) {
    return 'toast'
  }
  if ((surface !== 'push' && tier !== 'urgent') || !(await anyPushDevice(hears))) {
    return 'digest'
  }
  pushes.push(at)
  return 'push'
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
