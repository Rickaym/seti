import type { SubtaskBrief, WireRow } from '@seti/shared'
import { CircleX, Inbox, Loader } from 'lucide-react'
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { rowCalls, rowResults } from '@/lib/transcript'
import { cn } from '@/lib/utils'
import { PromptEntry } from '@/panels/tasks/PromptEntry'
import { ToolKindIcon } from '@/panels/tasks/ToolCall'
import { AgentText, Transcript } from '@/panels/tasks/Transcript'
import { digest, type ChatItem, type WorkSpan } from '@/panels/tasks/proto/digest'
import { kindCounts, workFacts } from '@/panels/tasks/proto/facts'
import { PersonMessage, SpanDetail, StandingFailure, WorkLine } from '@/panels/tasks/proto/parts'

interface BodyProps {
  /** A now bar sits under the transcript, as in the a-plus design. */
  nowBar?: boolean
  taskId: string
  messages: readonly WireRow[]
  running: boolean
  subtasks: readonly SubtaskBrief[]
}

/** A row the digest keeps whole, such as a question or a note from Seti, with its results. */
function WholeRow({ taskId, row, messages, subtasks }: BodyProps & { row: WireRow }) {
  const rows = useMemo(() => {
    const calls = new Set(rowCalls(row).map((call) => call.callId))
    return messages.filter((other) => other === row || rowResults(other).some((ref) => calls.has(ref.callId)))
  }, [row, messages])
  return (
    <Transcript taskId={taskId} messages={rows} rewinds={[]} running={false} subtasks={subtasks} subagentRows={false} />
  )
}

/** One line of the conversation; work is left to the caller. */
function Said({ item, props }: { item: Exclude<ChatItem, { type: 'work' }>; props: BodyProps }) {
  switch (item.type) {
    case 'user':
      return <PromptEntry taskId={props.taskId} row={item.row} voice={false} />
    case 'agent':
      return <AgentText text={item.text} />
    case 'person':
      return <PersonMessage input={item.input} at={item.row.created_at} />
    case 'ask':
    case 'alert':
      return <WholeRow {...props} row={item.row} />
  }
}

const itemKey = (item: ChatItem) =>
  item.type === 'work' ? `w-${String(item.span.rows[0]?.id ?? 0)}` : `r-${String(item.row.id)}`

/** Stretches without calls hold only updates, which the strip at the top already shows. */
const shownInFlow = (item: ChatItem) => item.type !== 'work' || item.span.calls.length > 0

/** A: the conversation, with each stretch of work folded into one quiet line. */
export function ConversationBody(props: BodyProps) {
  const items = useMemo(() => digest(props.messages, props.running), [props.messages, props.running])
  return (
    <div className="space-y-3">
      {items.filter(shownInFlow).map((item) => (
        <div key={itemKey(item)} data-message-id={item.type === 'work' ? undefined : item.row.id}>
          {item.type === 'work' ? (
            <WorkLine
              taskId={props.taskId}
              span={item.span}
              running={props.running}
              subtasks={props.subtasks}
              nowBar={props.nowBar === true}
            />
          ) : (
            <Said item={item} props={props} />
          )}
        </div>
      ))}
    </div>
  )
}

/** A line of the conversation and the work that followed it, which the lane beside it marks. */
interface Pair {
  said: Exclude<ChatItem, { type: 'work' }> | null
  work: WorkSpan | null
}

function pairUp(items: readonly ChatItem[]): Pair[] {
  const pairs: Pair[] = []
  for (const item of items) {
    const last = pairs.at(-1)
    if (item.type === 'work') {
      if (last?.work === null) {
        last.work = item.span
      } else {
        pairs.push({ said: null, work: item.span })
      }
    } else {
      pairs.push({ said: item, work: null })
    }
  }
  return pairs
}

const MAX_MARKS = 3

interface Mark {
  key: string
  icon: ReactNode
  count: number
  className?: string
}

/** Failures first, then how many updates arrived, then the busiest kinds of call; three at most. */
function marksOf(span: WorkSpan, running: boolean): Mark[] {
  const marks: Mark[] = []
  const failed = span.failed + span.refused
  if (failed > 0) {
    marks.push({
      key: 'failed',
      icon: <CircleX className="size-3" aria-hidden />,
      count: failed,
      className: 'text-destructive',
    })
  }
  if (span.updates.length > 0) {
    marks.push({ key: 'updates', icon: <Inbox className="size-3" aria-hidden />, count: span.updates.length })
  }
  for (const count of kindCounts(span)) {
    marks.push({ key: count.kind, icon: <ToolKindIcon kind={count.kind} className="size-3" />, count: count.count })
  }
  const live = running && span.live !== null
  return marks.slice(0, live ? MAX_MARKS - 1 : MAX_MARKS)
}

/** The marks of one stretch in the lane: failures, updates and the busiest kinds of call. */
function LaneMarks({ span, running }: { span: WorkSpan; running: boolean }) {
  return (
    <span className="flex flex-col items-center gap-0.5 text-2xs leading-4 text-muted-foreground tabular-nums">
      {running && span.live !== null && <Loader className="size-3.5 motion-safe:animate-spin" aria-hidden />}
      {marksOf(span, running).map((mark) => (
        <span key={mark.key} className={cn('flex items-center gap-0.5', mark.className)}>
          {mark.icon}
          {mark.count}
        </span>
      ))}
    </span>
  )
}

function LanePair({ pair, props }: { pair: Pair; props: BodyProps }) {
  const [open, setOpen] = useState(false)
  const { work } = pair
  const label = work === null ? '' : `Show work: ${workFacts(work)}`
  return (
    <>
      <div className="border-r border-border pb-3">
        {work !== null && (
          <button
            type="button"
            aria-label={label}
            aria-expanded={open}
            title={label}
            data-testid="lane-marks"
            className={cn(
              'flex w-full justify-center py-1 hover:bg-muted/60 pointer-coarse:min-h-11',
              open && 'bg-muted/60 text-foreground',
            )}
            onClick={() => {
              setOpen(!open)
            }}
          >
            <LaneMarks span={work} running={props.running} />
          </button>
        )}
      </div>
      <div className="min-w-0 space-y-2 pb-3 pl-3" data-message-id={pair.said?.row.id}>
        {pair.said !== null && <Said item={pair.said} props={props} />}
        {work !== null && <StandingFailure span={work} />}
      </div>
      {open && work !== null && (
        <div className="col-span-2 pb-3">
          <SpanDetail taskId={props.taskId} rows={work.rows} running={props.running} subtasks={props.subtasks} />
        </div>
      )}
    </>
  )
}

/** C: the conversation in the main column, with the work in a narrow lane of marks to its left. */
export function LanesBody(props: BodyProps) {
  const pairs = useMemo(() => pairUp(digest(props.messages, props.running)), [props.messages, props.running])
  return (
    <div className="grid grid-cols-[2.75rem_minmax(0,1fr)]" data-testid="lanes">
      {pairs.map((pair, n) => (
        <Fragment key={pair.said === null ? `p-${String(n)}` : `p-${String(pair.said.row.id)}`}>
          <LanePair pair={pair} props={props} />
        </Fragment>
      ))}
    </div>
  )
}
