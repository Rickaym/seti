import type { EaInboxUnread } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const unread = createPolledResource<EaInboxUnread>('/ea/inbox/unread', 10_000)

/** What the EA inbox holds that the user has not seen: posted to the chat, or still waiting. */
export const useEaUnread = () => usePolled(unread)

export const refreshEaUnread = () => {
  unread.refresh()
}
