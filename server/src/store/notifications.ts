import { attentionTiersInput, DEFAULT_TIERS, type NotificationSettings, type PushDevice } from '@seti/shared'
import { now, sql, transaction } from '../db.js'

/** A device's push subscription as web-push takes it. */
export interface PushTarget {
  device_id: string
  endpoint: string
  keys: { p256dh: string; auth: string }
}

interface DeviceRecord {
  device_id: string
  endpoint: string
  p256dh: string
  auth: string
}

const target = (row: DeviceRecord): PushTarget => ({
  device_id: row.device_id,
  endpoint: row.endpoint,
  keys: { p256dh: row.p256dh, auth: row.auth },
})

export const pushDevices = {
  list: async (): Promise<PushDevice[]> =>
    sql<PushDevice[]>`SELECT device_id, label, created_at FROM push_device ORDER BY created_at, device_id`,
  targets: async (): Promise<PushTarget[]> =>
    (
      await sql<DeviceRecord[]>`SELECT device_id, endpoint, p256dh, auth FROM push_device
        ORDER BY created_at, device_id`
    ).map(target),
  /** Saves the device's subscription; an endpoint another device held moves to this one. */
  put: async (device: PushTarget & { label: string }): Promise<void> => {
    const at = now()
    await transaction(async (tx) => {
      await tx`DELETE FROM push_device WHERE endpoint = ${device.endpoint} AND device_id <> ${device.device_id}`
      await tx`INSERT INTO push_device (device_id, endpoint, p256dh, auth, label, created_at, updated_at)
        VALUES (${device.device_id}, ${device.endpoint}, ${device.keys.p256dh}, ${device.keys.auth},
          ${device.label}, ${at}, ${at})
        ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
          auth = excluded.auth, label = excluded.label, updated_at = excluded.updated_at`
    })
  },
  /** Removes the device's subscription and returns its label, or null when it had none. */
  remove: async (deviceId: string): Promise<string | null> =>
    (await sql<{ label: string }[]>`DELETE FROM push_device WHERE device_id = ${deviceId} RETURNING label`).at(0)
      ?.label ?? null,
  /** Drops a subscription the push service no longer knows, unless the device subscribed again. */
  removeEndpoint: async (deviceId: string, endpoint: string): Promise<void> => {
    await sql`DELETE FROM push_device WHERE device_id = ${deviceId} AND endpoint = ${endpoint}`
  },
}

/** Stored tiers over the defaults; a value this release does not know falls back to its default. */
function tiersOf(stored: unknown): NotificationSettings {
  const parsed = attentionTiersInput.safeParse(stored)
  const known = parsed.success ? parsed.data : {}
  return {
    urgent: known.urgent ?? DEFAULT_TIERS.urgent,
    active: known.active ?? DEFAULT_TIERS.active,
    digest: known.digest ?? DEFAULT_TIERS.digest,
    passive: known.passive ?? DEFAULT_TIERS.passive,
  }
}

export const notificationSettings = {
  get: async (): Promise<NotificationSettings> =>
    tiersOf((await sql<{ tiers: unknown }[]>`SELECT tiers FROM notification_settings WHERE id = 1`).at(0)?.tiers),
  /** Saves the tiers, and the old per-kind switches they imply for an earlier release. */
  set: async (tiers: NotificationSettings): Promise<void> => {
    const finished = tiers.active !== 'off'
    const needsYou = tiers.urgent === 'push'
    await sql`INSERT INTO notification_settings (id, finished, needs_you, ea_replies, tiers, updated_at)
      VALUES (1, ${finished}, ${needsYou}, true, ${sql.json({ ...tiers })}, ${now()})
      ON CONFLICT (id) DO UPDATE SET finished = excluded.finished, needs_you = excluded.needs_you,
        tiers = excluded.tiers, updated_at = excluded.updated_at`
  },
}
