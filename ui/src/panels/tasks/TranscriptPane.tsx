import type { MessageRow, OwnMessageStep, SubtaskBrief, TaskRewind } from '@seti/shared'
import { ArrowDown, ArrowDownToLine, ArrowUp } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Button } from '@/components/ui/button'
import { FindFocusContext, useFindMarks, type FindMarks } from '@/hooks/useFindMarks'
import { useLoadingPlaceholder } from '@/hooks/useLoadingPlaceholder'
import type { OwnDirection } from '@/lib/own-messages'
import { usePanelScroll } from '@/lib/panels'
import { countNewer } from '@/lib/transcript'
import { cn } from '@/lib/utils'
import { OwnMessageNav } from '@/panels/tasks/OwnMessageNav'
import { Transcript } from '@/panels/tasks/Transcript'
import type { TranscriptMarks } from '@/panels/tasks/TranscriptMarks'
import { TranscriptPlaceholder, type Placeholder } from '@/panels/tasks/TranscriptSkeleton'
import { useOwnMessages } from '@/panels/tasks/useOwnMessages'

/** Loaded rows of a transcript and a way to load the page before them. */
export interface TranscriptSource {
  messages: readonly MessageRow[]
  hasOlder: boolean
  loadingOlder: boolean
  /** Loads `limit` rows before the oldest loaded message; resolves false when nothing was added. */
  loadOlder: (limit?: number) => Promise<boolean>
  /** A stretch far back that find jumped to, for transcripts that support one. */
  stretch?: TranscriptWindow
  /** Shows the stretch around a message, for transcripts that support one. */
  jumpTo?: (id: number) => Promise<void>
  /** Finds the user's own messages past the loaded rows, for transcripts kept in the database. */
  findOwn?: (direction: OwnDirection, from: number) => Promise<OwnMessageStep>
}

/** A stretch of a transcript far back, cut off from the newest messages until it reaches them. */
export interface TranscriptWindow {
  detached: boolean
  /** Messages after the shown stretch exist; only while detached. */
  hasNewer: boolean
  loadingNewer: boolean
  /** Loads `limit` rows after the shown stretch; resolves false when nothing was added. */
  loadNewer: (limit?: number) => Promise<boolean>
  backToLatest: () => void
  /** Changes each time the view should return to the newest messages. */
  latestRequest: number
}

const ATTACHED: TranscriptWindow = {
  detached: false,
  hasNewer: false,
  loadingNewer: false,
  loadNewer: async () => Promise.resolve(false),
  backToLatest: () => undefined,
  latestRequest: 0,
}

function PageButton({ later, loading, onClick }: { later: boolean; loading: boolean; onClick: () => void }) {
  const Icon = later ? ArrowDown : ArrowUp
  const label = later ? 'Load later' : 'Load earlier'
  return (
    <div className={cn('flex justify-center', later ? 'mt-3' : 'mb-3')}>
      <Button variant="outline" size="xs" disabled={loading} onClick={onClick}>
        <Icon />
        {loading ? 'Loading...' : label}
      </Button>
    </div>
  )
}

const FLOATING = 'absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md'

/** Back to the newest messages: from a stretch far back, or past messages that arrived below. */
function LatestButton({ stretch, unseen, onJump }: { stretch: TranscriptWindow; unseen: number; onJump: () => void }) {
  if (stretch.detached) {
    return (
      <Button size="xs" className={FLOATING} data-testid="back-to-latest" onClick={stretch.backToLatest}>
        <ArrowDownToLine />
        Back to latest
      </Button>
    )
  }
  if (unseen === 0) {
    return null
  }
  return (
    <Button
      size="xs"
      className={FLOATING}
      aria-label={`${String(unseen)} new ${unseen === 1 ? 'message' : 'messages'}, jump to latest`}
      onClick={onJump}
    >
      <ArrowDown />
      {unseen} new
    </Button>
  )
}

/** Messages sent from this page that the transcript has no rows for yet. */
export interface PendingRows {
  rows: ReactNode
  count: number
  /** Changes each time a message is sent, which brings the view back to the newest rows. */
  added: number
}

const NO_UNSENT: PendingRows = { rows: null, count: 0, added: 0 }

const orNone = (unsent: PendingRows | undefined) => unsent ?? NO_UNSENT

/** Spaced like one more row, so a stored row that replaces one lands in the same place. */
function UnsentRows({ unsent, first }: { unsent: PendingRows; first: boolean }) {
  return unsent.count === 0 ? null : <div className={cn(!first && 'mt-3')}>{unsent.rows}</div>
}

/** Where the first page of a transcript stands while it loads. */
export interface TranscriptLoad {
  /** The first page has not arrived yet. */
  pending: boolean
  failed: boolean
  onRetry: () => void
}

const NEAR_BOTTOM_PX = 80
const LOAD_OLDER_PX = 400

/** The row at the top of the view and its offset, kept in place when earlier rows load. */
interface Anchor {
  oldest: number
  id: string | undefined
  offset: number
}

const isNearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX

/** Rows that never leave the bottom zone, so no scroll up can ask for earlier ones. */
const isUnderfilled = (el: HTMLElement) => el.scrollHeight - el.clientHeight <= NEAR_BOTTOM_PX

/** A row, or the group of tool calls it folded into, which keeps the id when earlier calls join. */
const rowNode = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLElement>(`[data-message-id="${id}"], [data-message-rows~="${id}"]`)

/** Orphan results merge into their call once it loads, so they never serve as the anchor. */
function captureAnchor(el: HTMLElement, oldest: number): Anchor {
  const top = el.getBoundingClientRect().top
  for (const node of el.querySelectorAll<HTMLElement>('[data-message-id]:not([data-orphan]), [data-message-rows]')) {
    const rect = node.getBoundingClientRect()
    if (rect.bottom > top) {
      const id = node.dataset.messageId ?? node.dataset.messageRows?.split(' ').at(-1)
      return { oldest, id, offset: rect.top - top }
    }
  }
  return { oldest, id: undefined, offset: 0 }
}

function anchorShift(el: HTMLElement, anchor: Anchor): number {
  const node = anchor.id === undefined ? null : rowNode(el, anchor.id)
  return node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset : 0
}

/** What stands in for the rows until the first page arrives, or null once they show. */
function usePlaceholder(load: TranscriptLoad | undefined): Placeholder | null {
  const failed = load?.pending === true && load.failed
  const { skeleton, slow } = useLoadingPlaceholder(load?.pending === true && !failed)
  if (failed) {
    return 'retry'
  }
  if (!skeleton) {
    return null
  }
  return slow ? 'slow' : 'skeleton'
}

/** Follows new messages only from the bottom and loads earlier pages without moving the view. */
function EmptyLine({
  text,
  shown,
  older,
  running,
}: {
  text: string | undefined
  shown: number
  older: boolean
  running: boolean
}) {
  if (text === undefined || shown > 0 || older || running) {
    return null
  }
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>
}

export function TranscriptPane({
  taskId,
  stream,
  rewinds,
  running,
  subtasks,
  subagentRows = false,
  marks,
  contentClassName,
  load,
  find = null,
  empty,
  unsent,
  children,
}: {
  taskId: string
  stream: TranscriptSource
  rewinds: readonly TaskRewind[]
  running: boolean
  subtasks: readonly SubtaskBrief[]
  /** Show messages of subagents, as a subtask's own transcript does; the task's hides them. */
  subagentRows?: boolean
  /** Voice rows and dividers, for the EA chat. */
  marks?: TranscriptMarks
  /** Classes for the column the rows sit in, such as a narrower centred one. */
  contentClassName?: string
  /** Shows a skeleton while the first page loads, and a retry when it failed. */
  load?: TranscriptLoad
  /** Matches to light and the hit to show, while find is open. */
  find?: FindMarks | null
  /** One line for a transcript with no messages while no turn runs. */
  empty?: string
  /** Shown after the rows, as the rows they will become. */
  unsent?: PendingRows
  children?: ReactNode
}) {
  const { messages, hasOlder, loadingOlder, loadOlder } = stream
  const stretch = stream.stretch ?? ATTACHED
  const { detached, latestRequest } = stretch
  const placeholder = usePlaceholder(load)
  // Before the skeleton's delay passes the pane stays blank, so nothing shows and then vanishes.
  const covered = placeholder !== null || load?.pending === true
  const scroller = useRef<HTMLElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const anchor = useRef<Anchor | null>(null)
  const newest = useRef(0)
  const [unseenAfter, setUnseenAfter] = useState<number | null>(null)
  const unseen = useMemo(
    () => (unseenAfter === null ? 0 : countNewer(messages, unseenAfter, subagentRows)),
    [messages, unseenAfter, subagentRows],
  )

  const requestOlder = (limit?: number): Promise<boolean> | null => {
    const el = scroller.current
    if (!el || !hasOlder || loadingOlder || anchor.current) {
      return null
    }
    anchor.current = captureAnchor(el, messages[0]?.id ?? 0)
    return loadOlder(limit).then((added) => {
      if (!added) {
        anchor.current = null
      }
      return added
    })
  }

  /** Reveals earlier rows while those shown sit at the bottom without filling the view. */
  const fill = useEffectEvent(() => {
    const el = scroller.current
    if (el && !covered && !detached && stick.current && isUnderfilled(el)) {
      void requestOlder()
    }
  })

  useLayoutEffect(() => {
    if (detached) {
      stick.current = false
    }
  }, [detached])

  useLayoutEffect(() => {
    newest.current = messages.at(-1)?.id ?? 0
    const el = scroller.current
    const pending = anchor.current
    if (!el) {
      return
    }
    if (pending && (messages[0]?.id ?? 0) < pending.oldest) {
      anchor.current = null
      if (!stick.current) {
        el.scrollTop += anchorShift(el, pending)
        stick.current = isNearBottom(el)
      }
    }
    if (stick.current) {
      el.scrollTop = el.scrollHeight
    }
    fill()
  }, [messages, covered])

  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      if (stick.current) {
        el.scrollTop = el.scrollHeight
      }
      fill()
    })
    observer.observe(inner)
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && latestRequest > 0) {
      stick.current = true
      setUnseenAfter(null)
      el.scrollTop = el.scrollHeight
    }
  }, [latestRequest])

  const { added, count: unsentCount } = orNone(unsent)
  const follow = useEffectEvent(() => {
    const el = scroller.current
    if (el && added > 0 && !detached) {
      stick.current = true
      setUnseenAfter(null)
      el.scrollTop = el.scrollHeight
    }
  })
  useLayoutEffect(() => {
    follow()
  }, [added])

  const unstick = useCallback(() => {
    stick.current = false
  }, [])
  useFindMarks(content, find, messages, unstick)

  const requestNewer = (limit?: number): Promise<boolean> | null =>
    stretch.hasNewer && !stretch.loadingNewer ? stretch.loadNewer(limit) : null

  const onScroll = () => {
    const el = scroller.current
    if (!el) {
      return
    }
    const atBottom = isNearBottom(el)
    if (detached) {
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= LOAD_OLDER_PX) {
        void requestNewer()
      }
    } else {
      stick.current = atBottom
      setUnseenAfter((prev) => (atBottom ? null : (prev ?? newest.current)))
    }
    // Scrolls at the bottom come from sticking there or from rows hiding, never from reading up.
    if (!covered && !atBottom && el.scrollTop <= LOAD_OLDER_PX) {
      void requestOlder()
    }
  }

  const jumpToLatest = () => {
    const el = scroller.current
    if (detached) {
      stretch.backToLatest()
    } else if (el) {
      el.scrollTop = el.scrollHeight
    }
  }

  usePanelScroll(scroller, jumpToLatest)

  const own = useOwnMessages({
    scroller,
    content,
    messages,
    hasOlder,
    loadingOlder,
    requestOlder,
    requestNewer,
    detached,
    jumpTo: stream.jumpTo,
    findOwn: stream.findOwn,
    unstick,
    toLatest: jumpToLatest,
    atLatest: () => !detached && scroller.current !== null && isNearBottom(scroller.current),
  })

  return (
    <div className="relative min-h-0 flex-1">
      {/* An opaque scroller is one Chrome scrolls on the compositor on screens of pixel ratio 1. */}
      <section
        ref={scroller}
        aria-label="Transcript"
        onScroll={onScroll}
        className="h-full overflow-y-auto bg-background px-5 py-4 [overflow-anchor:none] max-md:px-3 max-md:py-3 in-data-agent-frame:px-3 in-data-agent-frame:py-2"
      >
        <div ref={content} className={contentClassName}>
          {placeholder !== null && <TranscriptPlaceholder shown={placeholder} onRetry={load?.onRetry} />}
          {!covered && (
            <>
              {hasOlder && (
                <PageButton
                  later={false}
                  loading={loadingOlder}
                  onClick={() => {
                    void requestOlder()
                  }}
                />
              )}
              <EmptyLine text={empty} shown={messages.length + unsentCount} older={hasOlder} running={running} />
              <FindFocusContext value={find?.focusId ?? null}>
                <Transcript
                  taskId={taskId}
                  messages={messages}
                  rewinds={rewinds}
                  running={running}
                  subtasks={subtasks}
                  subagentRows={subagentRows}
                  {...(marks === undefined ? {} : { marks })}
                />
              </FindFocusContext>
              {stretch.hasNewer ? (
                <PageButton
                  later
                  loading={stretch.loadingNewer}
                  onClick={() => {
                    void requestNewer()
                  }}
                />
              ) : (
                <>
                  <UnsentRows unsent={orNone(unsent)} first={messages.length === 0} />
                  {children}
                </>
              )}
            </>
          )}
        </div>
      </section>
      <LatestButton stretch={stretch} unseen={unseen} onJump={jumpToLatest} />
      {!covered && <OwnMessageNav nav={own.nav} seeking={own.seeking} onStep={own.step} />}
    </div>
  )
}
