import { DEFAULT_NOTIFY_SCOPE, hearsWorkspace, type NotifyScope, type NotifyScopeInput } from '@seti/shared'
import { audit } from './audit.js'
import { HttpError } from './http.js'
import { notifyScopes, pushDevices } from './store/notifications.js'
import { workspaceRows } from './store/workspaces.js'

/** Whether the device with this id is notified about an event. */
export type Audience = (deviceId: string) => boolean

const EVERYONE: Audience = () => true

/**
 * The devices notified about an agent in `workspaceId`, as each device's scope stands now. Null
 * is a notice about no one agent, which every device gets.
 */
export async function audienceOf(workspaceId: string | null): Promise<Audience> {
  if (workspaceId === null) {
    return EVERYONE
  }
  const scopes = await notifyScopes.all()
  return (deviceId) => hearsWorkspace(scopes.get(deviceId) ?? DEFAULT_NOTIFY_SCOPE, workspaceId)
}

/**
 * Records the workspace a device shows, or whether its notifications keep to it. The open
 * workspace is view state like a focus report; only a change to the setting is audited.
 */
export async function changeNotifyScope(deviceId: string, change: NotifyScopeInput): Promise<NotifyScope> {
  if (change.workspace_id !== undefined && (await workspaceRows.get(change.workspace_id)) === undefined) {
    throw new HttpError(404, 'No such workspace')
  }
  const before = await notifyScopes.get(deviceId)
  const next = await notifyScopes.set(deviceId, change)
  if (next.workspace_only !== before.workspace_only) {
    const pushLabel = (await pushDevices.list()).find((device) => device.device_id === deviceId)?.label
    const label = pushLabel ?? 'a device without push'
    await audit.record({
      actor: 'user',
      kind: 'system.notifications_changed',
      subject_type: 'system',
      summary: next.workspace_only
        ? `Notifications of ${label} keep to its open workspace`
        : `Notifications of ${label} cover every workspace`,
      detail: { device: label, workspace_only: next.workspace_only },
    })
  }
  return next
}
