import { Lock } from 'lucide-react'
import { ItemHint, StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { useSystem } from '@/hooks/useSystem'

export function PermissionModeItem() {
  const mode = useSystem().data?.permission_mode
  if (mode === undefined) {
    return null
  }
  return (
    <StatusBarItem
      label={`Permission mode ${mode}`}
      name="Permissions"
      tooltip={
        <ItemHint title={`Permission mode: ${mode}`}>
          <span>
            Agents follow the rules in Settings, Permissions and edit in their own directories. A classifier allows or
            turns down other calls; one it cannot decide waits for you.
          </span>
        </ItemHint>
      }
    >
      <Lock className="size-3" />
    </StatusBarItem>
  )
}
