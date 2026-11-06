import { MessagesSquare } from 'lucide-react'
import type { ComponentProps } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { TEAM_SHORTCUT, useTeamChat, useTeamChatStore } from './team-context'
import { unreadCount } from './team-store'

const BADGE_MAX = 99

/** Opens and closes the group chat panel; the badge counts messages from others not yet seen. */
export function TeamChatToggle({
  side,
  className,
}: {
  side?: ComponentProps<typeof Hint>['side']
  className?: string
}) {
  const store = useTeamChatStore()
  const state = useTeamChat()
  const unread = unreadCount(state)
  const label = unread > 0 ? `Group chat, ${String(unread)} unread` : 'Group chat'
  return (
    <Hint text={`Group chat (${TEAM_SHORTCUT})`} side={side}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={state.open}
        aria-keyshortcuts="Control+Shift+L"
        data-testid="team-chat-toggle"
        className={cn('relative aria-pressed:bg-primary/10 aria-pressed:text-primary', className)}
        onClick={() => {
          store.toggle()
        }}
      >
        <MessagesSquare />
        {unread > 0 && (
          <span
            data-testid="team-chat-unread"
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-2xs leading-none font-semibold text-primary-foreground"
          >
            {unread > BADGE_MAX ? `${String(BADGE_MAX)}+` : unread}
          </span>
        )}
      </Button>
    </Hint>
  )
}
