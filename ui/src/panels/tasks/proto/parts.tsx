import type { SubtaskBrief, WireRow } from '@seti/shared'
import { ChevronRight, CircleX, Hash, MessagesSquare, X } from 'lucide-react'
import { useState } from 'react'
import { LinkedText } from '@/components/links/LinkedText'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DOT } from '@/lib/session-labels'
import { ageLabel, elapsedLabel } from '@/lib/time'
import { toolKind, toolSummary } from '@/lib/tool-summary'
import { cn } from '@/lib/utils'
import { InputEntry } from '@/panels/tasks/InputEntry'
import { RunningFor, Spinner, ToolKindIcon } from '@/panels/tasks/ToolCall'
import { Transcript } from '@/panels/tasks/Transcript'
import type { PersonInput, WorkSpan } from '@/panels/tasks/proto/digest'
import { chipLook, urgency, workFacts } from '@/panels/tasks/proto/facts'

const spanTook = (span: WorkSpan) => elapsedLabel(Date.parse(span.end) - Date.parse(span.start))

/** The classic transcript of one stretch, as the current view shows it. */
export function SpanDetail({
  taskId,
  rows,
  running,
  subtasks,
}: {
  taskId: string
  rows: readonly WireRow[]
  running: boolean
  subtasks: readonly SubtaskBrief[]
}) {
  return (
    <div className="border-l border-border py-2 pl-3" data-testid="span-detail">
      <Transcript
        taskId={taskId}
        messages={rows}
        rewinds={[]}
        running={running}
        subtasks={subtasks}
        subagentRows={false}
        ungrouped
      />
    </div>
  )
}

/** A failure the agent has not got past yet: it stays in sight whatever the design folds. */
export function StandingFailure({ span }: { span: WorkSpan }) {
  if (span.standing === null || span.live !== null) {
    return null
  }
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-destructive" data-testid="standing-failure">
      <CircleX className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate font-mono">{toolSummary(span.standing)}</span>
      <span className="shrink-0">failed</span>
    </div>
  )
}

/** One quiet line for a stretch of work; it opens the stretch's full transcript in place. */
export function WorkLine({
  taskId,
  span,
  running,
  subtasks,
  nowBar = false,
}: {
  taskId: string
  span: WorkSpan
  running: boolean
  subtasks: readonly SubtaskBrief[]
  /** The now bar under the panel shows the running call, so the line leaves it out. */
  nowBar?: boolean
}) {
  const [open, setOpen] = useState(false)
  const live = running ? span.live : null
  const facts = workFacts(span)
  return (
    <div data-testid="work-line" className="space-y-1">
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-6 w-full min-w-0 items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground pointer-coarse:min-h-11"
        onClick={() => {
          setOpen(!open)
        }}
      >
        <ChevronRight
          aria-hidden
          className={cn('size-3.5 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')}
        />
        <span className="shrink-0 text-foreground/80">{live === null ? `Worked ${spanTook(span)}:` : 'Working:'}</span>
        <span className="min-w-0 truncate">
          {facts}
          {span.files.length > 0 && (
            <span className="text-muted-foreground/80">
              {' '}
              {DOT}
              {span.files.join(', ')}
            </span>
          )}
        </span>
        <span className="flex-1" />
        {span.failed + span.refused > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-destructive" title="Failed or refused calls">
            <X className="size-3" aria-hidden />
            {span.failed + span.refused}
          </span>
        )}
        {live !== null && (
          <span className="flex shrink-0 items-center gap-1 tabular-nums">
            <Spinner />
            <RunningFor since={span.start} />
          </span>
        )}
      </button>
      {live !== null && !open && !nowBar && (
        <div className="flex min-w-0 items-center gap-2 pl-5.5 text-xs text-muted-foreground" data-testid="work-now">
          <ToolKindIcon kind={toolKind(live.call)} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-mono">{toolSummary(live.call)}</span>
        </div>
      )}
      {!open && (
        <div className="pl-5.5">
          <StandingFailure span={span} />
        </div>
      )}
      {open && <SpanDetail taskId={taskId} rows={span.rows} running={running} subtasks={subtasks} />}
    </div>
  )
}

const personWhere = (input: PersonInput) => (input.source === 'team' ? 'team chat' : input.channel)

const AUTHORS: Partial<Record<string, string>> = { user: 'You', ea: 'The EA' }

/** A person writing to the agent from team chat or Slack, shown as part of the conversation. */
export function PersonMessage({ input, at }: { input: PersonInput; at: string }) {
  const Icon = input.source === 'team' ? MessagesSquare : Hash
  return (
    <div className="space-y-1" data-testid="person-message">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0 text-actor-agent" aria-hidden />
        <span className="truncate">
          <span className="font-semibold text-foreground">{AUTHORS[input.subject] ?? input.subject}</span>
          {' in '}
          {personWhere(input)}
        </span>
        <span className="shrink-0 tabular-nums">{ageLabel(at)}</span>
      </div>
      <div className="border border-border bg-muted/40 px-3 py-2 text-sm break-words whitespace-pre-wrap">
        <LinkedText text={input.body} />
      </div>
    </div>
  )
}

const SHOWN_CHIPS = 2

type InputRow = Extract<WireRow, { kind: 'input' }>

function UpdateChip({ taskId, row }: { taskId: string; row: InputRow }) {
  const look = chipLook(row.payload)
  const Icon = look.icon
  return (
    <Popover>
      <PopoverTrigger
        className="flex min-w-0 shrink items-center gap-1.5 hover:underline pointer-coarse:min-h-11"
        title={`${row.payload.title}, ${ageLabel(row.created_at)} ago`}
        data-testid="update-chip"
      >
        <Icon className={cn('size-3.5 shrink-0', look.className)} aria-hidden />
        <span className="min-w-0 truncate text-foreground/90">{look.text}</span>
      </PopoverTrigger>
      <PopoverContent className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <InputEntry taskId={taskId} input={row.payload} queued={false} />
      </PopoverContent>
    </Popover>
  )
}

/** The current state of what changed since the user last wrote: the two most urgent, then +N. */
export function UpdatesStrip({
  taskId,
  updates,
  className,
}: {
  taskId: string
  updates: readonly InputRow[]
  className?: string
}) {
  if (updates.length === 0) {
    return null
  }
  const ranked = [...updates].sort((a, b) => urgency(a.payload) - urgency(b.payload) + (b.id < a.id ? -0.5 : 0.5))
  const rest = ranked.slice(SHOWN_CHIPS)
  return (
    <div
      className={cn('flex min-w-0 items-center gap-3 overflow-hidden text-xs whitespace-nowrap', className)}
      data-testid="updates-strip"
    >
      {ranked.slice(0, SHOWN_CHIPS).map((row) => (
        <UpdateChip key={row.id} taskId={taskId} row={row} />
      ))}
      {rest.length > 0 && (
        <Popover>
          <PopoverTrigger
            className="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:min-h-11"
            aria-label={`${String(rest.length)} more updates`}
          >
            +{rest.length}
          </PopoverTrigger>
          <PopoverContent className="max-h-96 w-96 max-w-[calc(100vw-2rem)] space-y-2 overflow-y-auto p-2">
            {rest.map((row) => (
              <InputEntry key={row.id} taskId={taskId} input={row.payload} queued={false} />
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
