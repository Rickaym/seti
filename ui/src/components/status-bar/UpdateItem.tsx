import { RotateCw } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { ItemHint, StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { updateNow, updateOffer } from '@/lib/app-update'

/** Shows while a new Seti build waits for a safe moment; clicking reloads into it now. */
export function UpdateItem() {
  const offered = useSyncExternalStore(updateOffer.subscribe, updateOffer.getSnapshot)
  if (!offered) {
    return null
  }
  return (
    <StatusBarItem
      label="Update"
      name="Update"
      tooltip={
        <ItemHint title="A new version of Seti is ready">
          <span>
            Click to reload into it now. Seti also reloads by itself once you stop typing, close the dialog or leave the
            page; your unsent messages stay.
          </span>
        </ItemHint>
      }
      onClick={updateNow}
    >
      <RotateCw className="size-3" />
      <span>Update</span>
    </StatusBarItem>
  )
}
