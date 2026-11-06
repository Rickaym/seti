import type { MessageRow } from '@seti/shared'
import { ChevronRight, ShieldAlert, X } from 'lucide-react'
import { memo, useContext, useMemo, useState, type ReactNode } from 'react'
import { FindFocusContext } from '@/hooks/useFindMarks'
import { durationOf, groupLabel, kindTallies, refusals, tallyTitle, toolSummary } from '@/lib/tool-summary'
import { resultText, rowCalls, type BackgroundStatus, type ToolResultRef, type ToolUseBlock } from '@/lib/transcript'
import { cn } from '@/lib/utils'
import { OutwardMark, RunningFor, Spinner, ToolKindIcon } from '@/panels/tasks/ToolCall'

interface GroupCall {
  block: ToolUseBlock
  at: string
  outward: boolean
}

function groupCalls(rows: readonly MessageRow[]): GroupCall[] {
  return rows.flatMap((row) => {
    const outward = new Set(row.outward)
    return rowCalls(row).map((block) => ({ block, at: row.created_at, outward: outward.has(block.id) }))
  })
}

function KindIcons({
  calls,
  results,
}: {
  calls: readonly GroupCall[]
  results: readonly (ToolResultRef | undefined)[]
}) {
  const tallies = kindTallies(
    calls.map((call, n) => ({ name: call.block.name, failed: results[n]?.block.is_error === true })),
  )
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1 text-muted-foreground max-sm:hidden">
      {tallies.map((tally) => (
        <span
          key={tally.kind}
          title={tallyTitle(tally)}
          data-testid="tool-group-kind"
          data-kind={tally.kind}
          className={cn('flex', tally.failed > 0 && 'text-destructive')}
        >
          <ToolKindIcon kind={tally.kind} className="size-3" />
        </span>
      ))}
    </span>
  )
}

interface ToolGroupProps {
  rows: readonly MessageRow[]
  /** Results of the group's calls, in call order. */
  results: readonly (ToolResultRef | undefined)[]
  /** Background processes the group's calls started, in call order. */
  background: readonly (BackgroundStatus | undefined)[]
  /** The task is running, so a call without a result is still going. */
  running: boolean
  renderRow: (row: MessageRow) => ReactNode
}

/** What needs a look inside a folded group: outward calls, sandbox refusals and failures. */
function GroupMarks({ outward, refused, failed }: { outward: number; refused: readonly string[]; failed: number }) {
  return (
    <>
      {outward > 0 && <OutwardMark count={outward} />}
      {refused.length > 0 && (
        <span
          className="flex shrink-0 items-center gap-1 text-destructive"
          title={refused.join('\n')}
          data-testid="tool-group-blocked"
        >
          <ShieldAlert aria-hidden className="size-3" />
          {refused.length}
          <span className="max-sm:hidden">blocked</span>
        </span>
      )}
      {failed > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-destructive" data-testid="tool-group-failed">
          <X aria-hidden className="size-3" />
          {failed}
          <span className="max-sm:hidden">failed</span>
        </span>
      )}
    </>
  )
}

/** Whether find stepped to a message inside the group: one of its rows or one of its results. */
function holds(rows: readonly MessageRow[], results: ToolGroupProps['results'], id: number | null): boolean {
  return id !== null && (rows.some((row) => row.id === id) || results.some((result) => result?.rowId === id))
}

/** A run of tool calls on one line; opening it lists each call as its own compact row. */
function ToolGroupView({ rows, results, background, running, renderRow }: ToolGroupProps) {
  const [expanded, setExpanded] = useState(false)
  const focusId = useContext(FindFocusContext)
  const open = expanded || holds(rows, results, focusId)
  const calls = useMemo(() => groupCalls(rows), [rows])
  const label = useMemo(() => groupLabel(calls.map((call) => call.block.name)), [calls])
  const failed = results.filter((result) => result?.block.is_error === true).length
  const outward = calls.filter((call) => call.outward).length
  const refused = useMemo(
    () => results.flatMap((result) => (result === undefined ? [] : refusals(resultText(result.block.content)))),
    [results],
  )
  const pending = running ? calls.findIndex((_, n) => results[n] === undefined) : -1
  const live = calls[pending]
  const last = live ?? calls.at(-1)
  const first = calls[0]
  const lastResult = results.findLast((result) => result !== undefined)
  const took = first === undefined ? null : durationOf(first.at, lastResult?.at)
  const watching = background.some((status) => status === 'running')
  return (
    <div
      data-tool-group=""
      data-testid="tool-group"
      data-message-rows={rows.map((row) => row.id).join(' ')}
      className={cn(
        'border-l-2 border-border bg-muted/40 text-xs',
        (failed > 0 || refused.length > 0) && 'border-destructive',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-7 w-full items-center gap-2 px-2 py-1 text-left hover:bg-muted/60 pointer-coarse:min-h-11"
        onClick={() => {
          setExpanded(!open)
        }}
      >
        <ChevronRight
          aria-hidden
          className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')}
        />
        <KindIcons calls={calls} results={results} />
        <span className="min-w-0 truncate font-semibold" title={label} data-testid="tool-group-label">
          {label}
        </span>
        {last !== undefined && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground" data-testid="tool-group-last">
            {toolSummary(last.block)}
          </span>
        )}
        <GroupMarks outward={outward} refused={refused} failed={failed} />
        {live === undefined ? (
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground tabular-nums">
            {watching && <Spinner />}
            {took}
          </span>
        ) : (
          <span
            className="flex shrink-0 items-center gap-1 text-muted-foreground tabular-nums"
            data-testid="tool-group-running"
          >
            <Spinner />
            <RunningFor since={live.at} />
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-px border-t border-border bg-background/40 py-px pl-3">{rows.map(renderRow)}</div>
      )}
    </div>
  )
}

const sameItems = <T,>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, index) => item === b[index])

/** Finished groups skip re-rendering while the stream appends rows after them. */
export const ToolGroup = memo(
  ToolGroupView,
  (a, b) =>
    a.running === b.running &&
    sameItems(a.rows, b.rows) &&
    sameItems(a.results, b.results) &&
    sameItems(a.background, b.background),
)
