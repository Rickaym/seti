import { Registry } from '@seti/shared'
import { useSyncExternalStore, type ComponentType } from 'react'
import { EaItem } from '@/components/ea/EaItem'
import { AccountItem } from '@/components/status-bar/AccountItem'
import { ApiStatusItem } from '@/components/status-bar/ApiStatusItem'
import { ChannelsItem } from '@/components/status-bar/ChannelsItem'
import { McpItem } from '@/components/status-bar/McpItem'
import { NeedsYouItem } from '@/components/status-bar/NeedsYouItem'
import { PermissionModeItem } from '@/components/status-bar/PermissionModeItem'
import { ResourcesItem } from '@/components/status-bar/ResourcesItem'
import { SandboxItem } from '@/components/status-bar/SandboxItem'

/** Work that needs a look on the left; plan usage, then health past a hairline on the right. */
type StatusSlot = 'work' | 'account' | 'health'

interface StatusItem {
  key: string
  /** What its error boundary calls it when it crashes. */
  name: string
  slot: StatusSlot
  view: ComponentType
}

/** The items of the status bar, Seti's own and the ones enabled mods add, in the work slot. */
export const statusBarItems = new Registry<StatusItem>('status bar item', (item) => item.key)

for (const item of [
  { key: 'ea', name: 'EA', slot: 'work', view: EaItem },
  { key: 'needs-you', name: 'Agents that need you', slot: 'work', view: NeedsYouItem },
  { key: 'account', name: 'Account', slot: 'account', view: AccountItem },
  { key: 'resources', name: 'Resources', slot: 'health', view: ResourcesItem },
  { key: 'mcp', name: 'MCP servers', slot: 'health', view: McpItem },
  { key: 'channels', name: 'Channels', slot: 'health', view: ChannelsItem },
  { key: 'api', name: 'API status', slot: 'health', view: ApiStatusItem },
  { key: 'sandbox', name: 'Sandbox', slot: 'health', view: SandboxItem },
  { key: 'permission-mode', name: 'Permission mode', slot: 'health', view: PermissionModeItem },
] as const) {
  statusBarItems.register(item)
}

/** The items of one slot, as they change while mods turn on and off. */
export function useStatusItems(slot: StatusSlot): StatusItem[] {
  return useSyncExternalStore(statusBarItems.subscribe, statusBarItems.list).filter((item) => item.slot === slot)
}
