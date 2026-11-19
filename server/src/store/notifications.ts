import {
  attentionTiersInput,
  DEFAULT_NOTIFY_SCOPE,
  DEFAULT_TIERS,
  type NotifyScope,
  type NotifyScopeInput,
  type NotificationSettings,
  type PushDevice,
} from '@seti/shared'
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

type ScopeRow = NotifyScope & { device_id: string }

const scopeOf = (row: NotifyScope | undefined): NotifyScope =>
  row === undefined ? DEFAULT_NOTIFY_SCOPE : { workspace_id: row.workspace_id, workspace_only: row.workspace_only }

/** The ids of the agents whose turn ended after `since`, whatever changed on them later. */
export async function turnEndedSince(since: string): Promise<Set<string>> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM task WHERE turn_ended_at > ${since}`
  return new Set(rows.map((row) => row.id))
}

export const notifyScopes = {
  get: async (deviceId: string): Promise<NotifyScope> =>
    scopeOf(
      (
        await sql<NotifyScope[]>`SELECT workspace_id, workspace_only FROM notify_scope WHERE device_id = ${deviceId}`
      ).at(0),
    ),
  /** Every device's scope by its id; a device with no entry has the default. */
  all: async (): Promise<Map<string, NotifyScope>> => {
    const rows = await sql<ScopeRow[]>`SELECT device_id, workspace_id, workspace_only FROM notify_scope`
    return new Map(rows.map((row) => [row.device_id, scopeOf(row)]))
  },
  /** Saves what the change names and keeps the rest; returns the device's scope after it. */
  set: async (deviceId: string, change: NotifyScopeInput): Promise<NotifyScope> => {
    const workspace = change.workspace_id ?? null
    const only = change.workspace_only ?? null
    const rows = await sql<NotifyScope[]>`
      INSERT INTO notify_scope (device_id, workspace_id, workspace_only, updated_at)
      VALUES (${deviceId}, ${workspace}, COALESCE(${only}::boolean, true), ${now()})
      ON CONFLICT (device_id) DO UPDATE SET
        workspace_id = COALESCE(${workspace}::text, notify_scope.workspace_id),
        workspace_only = COALESCE(${only}::boolean, notify_scope.workspace_only),
        updated_at = excluded.updated_at
      RETURNING workspace_id, workspace_only`
    return scopeOf(rows.at(0))
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
