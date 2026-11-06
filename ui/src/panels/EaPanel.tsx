import { EA_CONFIRM_QUESTION } from '@seti/shared'
import { Check, MessageSquarePlus, Phone, X } from 'lucide-react'
import { useEffect, useMemo, useRef, type ReactElement, type RefObject } from 'react'
import { apiPost } from '@/api'
import { Hint } from '@/components/Hint'
import { SetupCard } from '@/components/ea/SetupCard'
import { useEaCall, useEaCallStore, useEaHistoryStore } from '@/components/ea/call-context'
import { callActive } from '@/components/ea/call-state'
import { CALL_SHORTCUT } from '@/components/ea/call-status'
import { chatNeed, setupNeed, useEaHealth, type HealthState } from '@/components/ea/useEaHealth'
import { refreshEaUnread, useEaUnread } from '@/components/ea/useEaInbox'
import { markRepliesSeen, takeEaFocus, useEaChatShown, useEaReplies, useShowEaChat } from '@/components/ea/useEaReplies'
import { useNewConversation } from '@/components/ea/useNewConversation'
import { Button } from '@/components/ui/button'
import { useDraft } from '@/hooks/useDraft'
import { useEscapeKeys } from '@/hooks/useEscapeKeys'
import { useCoarsePointer } from '@/hooks/useMedia'
import { EA_CHAT_DRAFT } from '@/lib/drafts'
import { PANEL } from '@/lib/panels'
import { navigate } from '@/lib/route'
import { CallCard } from '@/panels/ea/CallCard'
import { EaComposer } from '@/panels/ea/EaComposer'
import { EaSettings } from '@/panels/ea/EaSettings'
import { InboxMenu } from '@/panels/ea/InboxMenu'
import { chatView, EA_TASK_ID, lastReply, liveRows } from '@/panels/ea/rows'
import { useEaChat } from '@/panels/ea/useEaChat'
import { TranscriptPane } from '@/panels/tasks/TranscriptPane'

const COLUMN = 'mx-auto w-full max-w-3xl'
const NO_REWINDS: [] = []
const NO_SUBTASKS: [] = []

function Empty() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="max-w-sm space-y-2 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Nothing said yet</p>
        <p>Ask what is running, which PRs need you, or what to start next. Type or call; both carry on here.</p>
      </div>
    </div>
  )
}

/** Quick answers to the EA asking before it acts; typing yes works just as well. */
function Confirm({ onAnswer }: { onAnswer: (text: string) => void }) {
  return (
    <div className="shrink-0 px-5 pt-2 max-md:px-3">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2" role="group" aria-label="Answer">
        <Button
          size="sm"
          onClick={() => {
            onAnswer('Yes, go ahead.')
          }}
        >
          <Check />
          Yes
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onAnswer('No, leave it.')
          }}
        >
          <X />
          No
        </Button>
      </div>
    </div>
  )
}

/** While the chat is on screen, loads new EA messages and marks them seen on every device. */
function useRepliesSeen(latest: number | undefined) {
  useShowEaChat()
  const shown = useEaChatShown()
  const { data } = useEaReplies()
  const store = useEaHistoryStore()
  const newer = (data?.replies ?? []).some((reply) => latest === undefined || reply.id > latest)
  useEffect(() => {
    if (shown && newer) {
      void store.refresh()
    }
  }, [shown, newer, store, data])
  const covered = (data?.replies ?? []).some((reply) => latest !== undefined && reply.id <= latest)
  const through = covered ? latest : undefined
  useEffect(() => {
    if (shown && through !== undefined) {
      markRepliesSeen({ through }).catch(() => undefined)
    }
  }, [shown, through])
}

/** Brings the message a notification opened into view once the chat shows it. */
function useFocusedMessage(root: RefObject<HTMLDivElement | null>, rows: readonly { id: number }[]) {
  useEffect(() => {
    const id = takeEaFocus((wanted) => rows.some((row) => row.id === wanted))
    if (id !== null) {
      root.current?.querySelector(`[data-message-id="${String(id)}"]`)?.scrollIntoView({ block: 'center' })
    }
  }, [root, rows])
}

/** Picks up what reaches the inbox while the chat is open, and marks it seen. */
function useInboxSeen() {
  const store = useEaHistoryStore()
  const { data } = useEaUnread()
  const unread = data?.unread ?? 0
  const waiting = data?.waiting ?? 0
  useEffect(() => {
    let live = true
    const settle = async () => {
      await store.refresh()
      if (live && unread > 0) {
        await apiPost('/ea/inbox/read', {})
        refreshEaUnread()
      }
    }
    settle().catch(() => undefined)
    return () => {
      live = false
    }
  }, [store, unread, waiting])
}

/** Touch screens skip the hint, which a tap would only flash. */
function Hinted({ text, touch, children }: { text: string; touch: boolean; children: ReactElement }) {
  return touch ? children : <Hint text={text}>{children}</Hint>
}

/** Starts a call from the page; while the EA lacks what calls need, it leads to the settings. */
function CallButton({ health, touch }: { health: HealthState; touch: boolean }) {
  const store = useEaCallStore()
  const need = setupNeed(health)
  const hint = need === null ? `Talk to the EA (${CALL_SHORTCUT.label})` : 'Calls need setup; opens Settings, EA'
  return (
    <Hinted text={hint} touch={touch}>
      <Button
        size={touch ? 'sm' : 'xs'}
        variant="ghost"
        aria-keyshortcuts={need === null ? CALL_SHORTCUT.aria : undefined}
        onClick={() => {
          if (need === null) {
            void store.connect()
          } else {
            navigate('settings', 'ea')
          }
        }}
      >
        <Phone className="size-4" />
        Call
      </Button>
    </Hinted>
  )
}

/** The EA as a typed chat and a call, over one conversation. */
export function EaPanel() {
  const chat = useEaChat()
  const { state, refresh } = useEaHealth()
  const need = chatNeed(state)
  const call = useEaCall()
  const calling = callActive(call.phase)
  const touch = useCoarsePointer()
  const startNew = useNewConversation()
  const [draft, setDraft] = useDraft(EA_CHAT_DRAFT)
  const root = useRef<HTMLDivElement>(null)
  const { entries, live, replying, stop } = chat
  useEscapeKeys({ root, busy: replying, onStop: stop })
  useInboxSeen()
  useRepliesSeen(entries.at(-1)?.id)

  const view = useMemo(() => chatView(entries), [entries])
  const inFlight = useMemo(() => liveRows(entries, live), [entries, live])
  const rows = useMemo(() => (inFlight.length === 0 ? view.rows : [...view.rows, ...inFlight]), [view, inFlight])
  const stream = {
    messages: rows,
    hasOlder: chat.hasOlder,
    loadingOlder: chat.loadingOlder,
    loadOlder: chat.loadOlder,
  }
  useFocusedMessage(root, rows)
  const asking = !replying && (lastReply(entries)?.trimEnd().endsWith(EA_CONFIRM_QUESTION) ?? false)
  const disabled = need === null ? null : 'The EA cannot answer until it is set up.'

  const send = async (text: string) => {
    setDraft('')
    if (!(await chat.send(text))) {
      setDraft(text)
    }
  }

  const actions = (
    <div className="flex shrink-0 items-center">
      {!calling && <CallButton health={state} touch={touch} />}
      <InboxMenu />
      <Hinted text="New conversation; the EA forgets this one" touch={touch}>
        <Button
          size={touch ? 'sm' : 'xs'}
          variant="ghost"
          className="text-muted-foreground"
          aria-label="New conversation"
          disabled={replying || entries.length === 0}
          onClick={() => void startNew()}
        >
          <MessageSquarePlus className="size-4" />
          New
        </Button>
      </Hinted>
      <EaSettings touch={touch} />
    </div>
  )

  return (
    <div ref={root} {...PANEL} className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">EA</h1>
      {need !== null && (
        <div className="shrink-0 text-xs">
          <SetupCard need={need} onCheck={refresh} blocked="answer" />
        </div>
      )}
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <TranscriptPane
          taskId={EA_TASK_ID}
          stream={stream}
          rewinds={NO_REWINDS}
          running={replying}
          subtasks={NO_SUBTASKS}
          marks={view.marks}
          contentClassName={COLUMN}
        />
      )}
      {calling && (
        <div className="shrink-0 px-3 pt-2 max-md:px-2">
          <div className={COLUMN}>
            <CallCard call={call} touch={touch} />
          </div>
        </div>
      )}
      {asking && <Confirm onAnswer={(text) => void chat.send(text)} />}
      <EaComposer
        draft={draft}
        onDraftChange={setDraft}
        replying={replying}
        retrying={chat.retrying}
        disabled={disabled}
        onSend={(text) => void send(text)}
        onStop={stop}
        actions={actions}
      />
    </div>
  )
}
