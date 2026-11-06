import { CircleAlert } from 'lucide-react'
import { ItemHint, StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { useAppBadge } from '@/hooks/useAppBadge'
import { needsYouLabel, useNeedsYou } from '@/hooks/useNeedsYou'

const LISTED_TITLES = 5

/** Agents that need the user in every workspace, also on the app icon; hidden while none do. */
export function NeedsYouItem() {
  const { titles, open } = useNeedsYou()
  const count = titles.length
  useAppBadge(count)
  if (count === 0) {
    return null
  }
  const more = count > LISTED_TITLES ? `, +${String(count - LISTED_TITLES)} more` : ''
  return (
    <StatusBarItem
      label={needsYouLabel(count)}
      name="Needs you"
      tone="danger"
      tooltip={
        <ItemHint title={`${String(count)} need you: ${titles.slice(0, LISTED_TITLES).join(', ')}${more}`}>
          <span>
            Turns that failed, that a Seti restart cut off or that ended with a question, which you have not opened yet,
            in every workspace. Click for the Needs you group.
          </span>
        </ItemHint>
      }
      onClick={open}
    >
      <CircleAlert className="size-3" />
      <span>{count} need you</span>
    </StatusBarItem>
  )
}
