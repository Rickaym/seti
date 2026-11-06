import type { TeamMember, TeamMessage } from '@seti/shared'
import { MessagesSquare } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { apiGet } from '@/api'
import { useCommands } from '@/components/palette/useCommands'
import { isNarrow } from '@/hooks/useMedia'
import { openEventStream } from '@/lib/event-stream'
import { liveStream } from '@/lib/live-stream'
import { isTeamShortcut, offerGroupChat, TEAM_SHORTCUT, TeamChatContext } from './team-context'
import { TeamChatStore } from './team-store'

/** Follows the group chat for the whole app, so the badge counts while the panel is closed. */
export function TeamChatProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new TeamChatStore({ restoreOpen: !isNarrow() }))
  const open = useSyncExternalStore(store.subscribe, () => store.getSnapshot().open)
  const connected = useSyncExternalStore(store.subscribe, () => store.getSnapshot().connected)

  useEffect(() => {
    const stream = openEventStream(
      '/team/stream',
      {
        onConnected: (up) => {
          store.setConnected(up)
          liveStream.setConnected(up)
        },
        events: {
          backlog: (event) => {
            liveStream.received()
            store.receiveBacklog(JSON.parse(event.data) as TeamMessage[])
          },
          reset: (event) => {
            liveStream.received()
            store.resetMessages(JSON.parse(event.data) as TeamMessage[])
          },
          message: (event) => {
            liveStream.received()
            store.receive([JSON.parse(event.data) as TeamMessage])
          },
          member: (event) => {
            liveStream.received()
            store.upsertMember(JSON.parse(event.data) as TeamMember)
          },
          ping: () => {
            liveStream.received()
          },
        },
      },
      { parkWhenHidden: true },
    )
    store.onReconnect(stream.reconnect)
    return () => {
      store.onReconnect(null)
      stream.close()
    }
  }, [store])

  // Each connection fetches the roster again, since member changes made while away are not resent.
  useEffect(() => {
    if (!open || !connected) {
      return
    }
    let current = true
    apiGet<TeamMember[]>('/team/members')
      .then((members) => {
        if (current) {
          store.setMembers(members)
        }
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [open, connected, store])

  useEffect(() => offerGroupChat(store), [store])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTeamShortcut(e) && !e.defaultPrevented) {
        e.preventDefault()
        if (!e.repeat) {
          store.toggle()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [store])

  useCommands([
    {
      id: 'team.toggle',
      title: open ? 'Close group chat' : 'Open group chat',
      icon: MessagesSquare,
      group: 'General',
      keywords: 'team messages',
      shortcut: TEAM_SHORTCUT,
      run: () => {
        store.toggle()
      },
    },
  ])

  return <TeamChatContext value={store}>{children}</TeamChatContext>
}
