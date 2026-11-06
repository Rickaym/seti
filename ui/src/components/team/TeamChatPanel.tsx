import { isDirect, type TeamMember, type TeamMessage } from '@seti/shared'
import { ArrowDown, ArrowDownToLine, ArrowUp, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/api'
import { ChatFindBar } from '@/components/ChatFindBar'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Hint } from '@/components/Hint'
import { RelativeTime } from '@/components/RelativeTime'
import { ResizablePane } from '@/components/resize/ResizablePane'
import { FIND_SHORTCUT } from '@/components/shortcuts/find'
import { useFocusLanding } from '@/components/shortcuts/landing'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useChatFindIn } from '@/hooks/useChatFind'
import { useFindMarks, type FindMarks } from '@/hooks/useFindMarks'
import { useNarrow } from '@/hooks/useMedia'
import { useOutsideDismiss } from '@/hooks/useOutsideDismiss'
import { useTasks } from '@/hooks/useTasks'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { PANES } from '@/lib/pane-size'
import { PANEL } from '@/lib/panels'
import { cn } from '@/lib/utils'
import { FileLinksContext, type FileLinks } from '@/panels/files/file-links'
import { openInTask } from '@/panels/files/open-in-task'
import { createPathResolver } from '@/panels/files/path-resolver'
import { DirectMark, DirectToggle } from './DirectMark'
import { MessageText } from './MessageText'
import { TeamComposer } from './TeamComposer'
import type { ColorOf } from './remark-mentions'
import { TEAM_SHORTCUT, useTeamChat, useTeamChatStore } from './team-context'
import { shownMessages } from './team-store'

const CHIP = 'inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 text-2xs font-semibold'
/** How close to the bottom the list must be to follow new messages. */
const FOLLOW_PX = 48

interface ChipProps {
  message: TeamMessage
  handles: ReadonlyMap<string, string>
  colorOf: ColorOf
}

function AuthorChip({ message, handles, colorOf }: ChipProps) {
  if (message.author_kind === 'user') {
    return <span className={cn(CHIP, 'bg-actor-user/20 text-foreground')}>You</span>
  }
  if (message.author_kind === 'ea') {
    return <span className={cn(CHIP, 'bg-primary/15 text-primary')}>EA</span>
  }
  if (message.author_kind === 'mod') {
    return <span className={cn(CHIP, 'bg-muted text-muted-foreground')}>{message.author_mod_id ?? 'a'} mod</span>
  }
  const id = message.author_task_id
  const handle = (id === null ? undefined : handles.get(id)) ?? message.author_handle ?? 'task'
  if (id === null) {
    return <span className={cn(CHIP, 'bg-actor-agent/20 text-muted-foreground')}>@{handle}</span>
  }
  return (
    <a
      href={`#agents/${id}`}
      {...agentColorAttr(colorOf(id))}
      className={cn(CHIP, 'agent-mark bg-actor-agent/20 text-foreground hover:underline')}
      data-author-task={id}
    >
      @{handle}
    </a>
  )
}

interface Detached {
  hasNewer: boolean
  loadingNewer: boolean
  onLoadNewer: () => void
  onLatest: () => void
}

function MessageList({
  messages,
  members,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  detached,
  latestRequest,
  find,
}: {
  messages: readonly TeamMessage[]
  members: readonly TeamMember[]
  hasOlder: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
  /** Set while the list shows a window around a search hit instead of the newest messages. */
  detached: Detached | null
  latestRequest: number
  find: FindMarks | null
}) {
  const list = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const fromBottom = useRef<number | null>(null)
  const handles = new Map(members.map((member) => [member.task_id, member.handle]))
  const { tasks } = useTasks()
  const colors = new Map(tasks.map((task) => [task.id, task.color]))
  const colorOf: ColorOf = (taskId) => colors.get(taskId) ?? null
  const latest = messages.at(-1)?.id
  const oldest = messages[0]?.id

  useLayoutEffect(() => {
    const element = list.current
    if (element !== null && following.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [latest])

  useLayoutEffect(() => {
    const element = list.current
    if (element !== null && fromBottom.current !== null) {
      element.scrollTop = element.scrollHeight - fromBottom.current
      fromBottom.current = null
    }
  }, [oldest])

  useLayoutEffect(() => {
    const element = list.current
    if (element !== null && latestRequest > 0) {
      following.current = true
      element.scrollTop = element.scrollHeight
    }
  }, [latestRequest])

  const unfollow = useCallback(() => {
    following.current = false
  }, [])
  useFindMarks(list, find, messages, unfollow)

  const loadOlder = () => {
    const element = list.current
    if (element !== null) {
      fromBottom.current = element.scrollHeight - element.scrollTop
    }
    onLoadOlder()
  }

  return (
    <div
      ref={list}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      role="log"
      aria-label="Group messages"
      aria-live="polite"
      onScroll={(e) => {
        const element = e.currentTarget
        following.current =
          detached === null && element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_PX
      }}
    >
      {messages.length === 0 && (
        <p className="py-6 text-center text-xs text-muted-foreground">
          No messages yet. Agents check in here, and @agent reaches one directly.
        </p>
      )}
      {hasOlder && (
        <div className="mb-2 flex justify-center">
          <Button variant="outline" size="xs" disabled={loadingOlder} onClick={loadOlder}>
            <ArrowUp />
            {loadingOlder ? 'Loading...' : 'Load earlier'}
          </Button>
        </div>
      )}
      <ul className="space-y-2.5">
        {messages.map((message) => (
          <li
            key={message.id}
            className="text-xs"
            data-testid="team-message"
            data-author={message.author_kind}
            data-message-id={message.id}
            data-direct={isDirect(message) || undefined}
          >
            <div className="mb-0.5 flex items-center gap-2">
              <AuthorChip message={message} handles={handles} colorOf={colorOf} />
              {isDirect(message) && <DirectMark message={message} handles={handles} />}
              <RelativeTime iso={message.created_at} className="text-2xs text-muted-foreground" />
            </div>
            <MessageText message={message} colorOf={colorOf} />
          </li>
        ))}
      </ul>
      {detached?.hasNewer === true && (
        <div className="mt-2 flex justify-center">
          <Button variant="outline" size="xs" disabled={detached.loadingNewer} onClick={detached.onLoadNewer}>
            <ArrowDown />
            {detached.loadingNewer ? 'Loading...' : 'Load later'}
          </Button>
        </div>
      )}
      {detached !== null && (
        <div className="sticky bottom-0 flex justify-center pt-2">
          <Button size="xs" className="shadow-md" data-testid="team-back-to-latest" onClick={detached.onLatest}>
            <ArrowDownToLine />
            Back to latest
          </Button>
        </div>
      )}
    </div>
  )
}

/** Workspace paths link to their agent's Files view; on phones the chat closes first. */
function useWorkspaceLinks(): FileLinks {
  const store = useTeamChatStore()
  const narrow = useNarrow()
  const resolver = useMemo(() => createPathResolver(null), [])
  return useMemo<FileLinks>(
    () => ({
      taskId: null,
      resolver,
      open: (target) => {
        if (target.task_id === undefined) {
          return
        }
        if (narrow) {
          store.setOpen(false)
        }
        openInTask(target.task_id, target)
      },
    }),
    [resolver, store, narrow],
  )
}

function TeamChatContent({ titled }: { titled: boolean }) {
  const store = useTeamChatStore()
  const state = useTeamChat()
  const links = useWorkspaceLinks()
  const body = useRef<HTMLDivElement>(null)
  useFocusLanding(body, 'team')
  const jumpTo = useCallback(async (id: number) => store.jumpTo(id), [store])
  const backToLatest = useCallback(() => {
    store.backToLatest()
  }, [store])
  const { find, closeFind, marks } = useChatFindIn({
    path: '/team/search',
    target: 'team',
    root: body,
    jumpTo,
    backToLatest,
    command: { id: 'team.find', title: 'Search the group chat', group: 'General' },
  })
  const shown = shownMessages(state)
  const [direct, setDirect] = useState(true)
  const messages = direct ? shown.messages : shown.messages.filter((message) => !isDirect(message))

  useEffect(() => {
    store.markSeen()
  }, [store, state.messages])

  const Title = titled ? SheetTitle : 'h2'
  return (
    <div ref={body} {...PANEL} className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Title className="text-sm font-semibold">Group chat</Title>
        {state.connected ? (
          <span className="size-1.5 rounded-full bg-success" aria-label="Live" role="img" />
        ) : (
          <Hint text="Disconnected. Reconnect to get the latest messages">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Reconnect"
              data-testid="team-chat-reconnect"
              onClick={() => {
                store.reconnect()
              }}
            >
              <RefreshCw className="text-muted-foreground" />
            </Button>
          </Hint>
        )}
        {titled && <SheetDescription className="sr-only">Messages between you, the EA and the agents</SheetDescription>}
        <DirectToggle shown={direct} onChange={setDirect} />
        <Hint text={`Find in the group chat (${FIND_SHORTCUT})`}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Find in the group chat"
            data-testid="team-find-open"
            onClick={find.openFind}
          >
            <Search />
          </Button>
        </Hint>
        <Hint text={`Close (${TEAM_SHORTCUT})`}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close group chat"
            onClick={() => {
              store.setOpen(false)
            }}
          >
            <X />
          </Button>
        </Hint>
      </div>
      <ChatFindBar find={find} onClose={closeFind} className="px-2" />
      <FileLinksContext.Provider value={links}>
        <MessageList
          messages={messages}
          members={state.members}
          hasOlder={shown.hasOlder}
          loadingOlder={state.loadingOlder}
          onLoadOlder={() => {
            void store.loadOlder().catch((e: unknown) => toast.error(errorText(e)))
          }}
          detached={
            state.window === null
              ? null
              : {
                  hasNewer: state.window.has_newer,
                  loadingNewer: state.loadingNewer,
                  onLoadNewer: () => {
                    void store.loadNewer().catch((e: unknown) => toast.error(errorText(e)))
                  },
                  onLatest: backToLatest,
                }
          }
          latestRequest={state.latestRequest}
          find={marks}
        />
      </FileLinksContext.Provider>
      <TeamComposer members={state.members} />
    </div>
  )
}

function TeamChatBody({ titled }: { titled: boolean }) {
  return (
    <ErrorBoundary name="Group chat">
      <TeamChatContent titled={titled} />
    </ErrorBoundary>
  )
}

/** Group chat beside the page, or over it with `overlay`; on phones a sheet navigating closes. */
export function TeamChatPanel({ overlay = false }: { overlay?: boolean }) {
  const narrow = useNarrow()
  const store = useTeamChatStore()
  const { open } = useTeamChat()
  const pane = useRef<HTMLDivElement>(null)
  useOutsideDismiss(overlay && open && !narrow, {
    inside: () => pane.current?.parentElement ?? null,
    state: open,
    onDismiss: () => {
      store.setOpen(false)
    },
  })
  useEffect(() => {
    if (!narrow || !open) {
      return
    }
    const close = () => {
      store.setOpen(false)
    }
    window.addEventListener('hashchange', close)
    return () => {
      window.removeEventListener('hashchange', close)
    }
  }, [narrow, open, store])
  if (narrow) {
    return (
      <Sheet
        open={open}
        onOpenChange={(next) => {
          store.setOpen(next)
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
          }}
          className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none"
          data-testid="team-chat-panel"
          data-typing-room=""
        >
          <TeamChatBody titled />
        </SheetContent>
      </Sheet>
    )
  }
  if (!open) {
    return null
  }
  return (
    <ResizablePane
      spec={PANES.team}
      side="end"
      label="Resize group chat"
      className={cn('flex flex-col bg-card', overlay && 'absolute inset-y-0 right-0 z-30 shadow-xl')}
    >
      <aside
        ref={pane}
        aria-label="Group chat"
        data-testid="team-chat-panel"
        className="flex min-h-0 flex-1 flex-col border-l border-border"
      >
        <TeamChatBody titled={false} />
      </aside>
    </ResizablePane>
  )
}
