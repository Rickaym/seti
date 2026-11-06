import { z } from 'zod'
import { attentionTiersInput, type AttentionTiers } from './attention.js'

/** What a push is about: a turn that ended, a state that waits on the user, or an EA item. */
export const NOTIFY_KINDS = ['finished', 'needs_you', 'ea'] as const
export type NotifyKind = (typeof NOTIFY_KINDS)[number]
/** What an agent's own push is about. */
export type AgentNotifyKind = Exclude<NotifyKind, 'ea'>

/** What a finished turn's toast and push say when the turn left no words to quote. */
export const NO_CLOSING_LINE = 'Ended its turn without a reply'

/** Where each attention tier reaches the user, for every device. */
export type NotificationSettings = AttentionTiers

export const notificationSettingsInput = attentionTiersInput

/** A browser's own id for itself, which it keeps in storage and sends with its subscription. */
export const deviceId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'A device id is 8 to 64 letters, digits, hyphens or underscores')

/** A browser's PushSubscription as its toJSON gives it. */
export const pushSubscriptionInput = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
})

export const pushDeviceInput = z.object({
  subscription: pushSubscriptionInput,
  /** How the settings page names the device, such as Chrome on Mac. */
  label: z.string().trim().min(1).max(80),
})
export type PushDeviceInput = z.input<typeof pushDeviceInput>

export const pushDeviceParams = z.object({ device_id: deviceId })

const FOCUS_AGENTS_MAX = 64

/** What a visible Seti page shows; `active` while its window also has focus. */
export const notificationFocusInput = z.object({
  device_id: deviceId,
  agents: z.array(z.string().trim().min(1).max(100)).max(FOCUS_AGENTS_MAX),
  active: z.boolean(),
})
export type NotificationFocusInput = z.input<typeof notificationFocusInput>

/** Leave out the device to send the test to every device. */
export const testNotificationInput = z.object({ device_id: deviceId.optional() })

/** A device that receives push notifications, never its endpoint or keys. */
export interface PushDevice {
  device_id: string
  label: string
  created_at: string
}

export interface NotificationStatus {
  /** The key browsers subscribe with; null when Seti cannot send push, as without its secret key. */
  public_key: string | null
  settings: NotificationSettings
  devices: PushDevice[]
}

export interface TestNotificationResult {
  sent: number
  failed: number
}

/** What a push carries to the service worker; `url` opens the agent. */
export interface NotificationPayload {
  title: string
  body: string
  /** The agent's id, so a newer notification of the agent replaces an older one. */
  tag: string
  url: string
  /** A mod's own kinds are `<mod>.<kind>`; mod_ask asks the user to allow something. */
  kind: NotifyKind | 'test' | 'mod_ask' | 'mod_update' | `${string}.${string}`
  /** Agents that need the user as it was sent, for the app icon; a test push leaves it out. */
  badge?: number
}

/** Where a notification about the agent opens Seti. */
export const agentUrl = (taskId: string) => `/#agents/${encodeURIComponent(taskId)}`
