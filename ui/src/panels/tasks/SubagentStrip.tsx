import type { SubtaskBrief } from '@seti/shared'
import { ChevronRight, Network } from 'lucide-react'
import { memo, useId, useState } from 'react'
import { CountBadge } from '@/components/CountBadge'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useNow } from '@/hooks/useNow'
import { navigate } from '@/lib/route'
import {
  runningBadge,
  SUBTASK_LABEL,
  subagentsLabel,
  subtaskCounts,
  subtaskElapsed,
  subtaskRouteId,
  subtaskTree,
  type SubtaskNode,
} from '@/lib/subtasks'
import { cn } from '@/lib/utils'
import { SubtaskLight } from '@/panels/tasks/StatusPill'

const INDENT_PX = 12
const openKey = (taskId: string) => `seti.agent.subagents-open.${taskId}`

function storedOpen(taskId: string): boolean {
  try {
    return localStorage.getItem(openKey(taskId)) === '1'
  } catch {
    return false
  }
}

function storeOpen(taskId: string, open: boolean): void {
  try {
    localStorage.setItem(openKey(taskId), open ? '1' : '0')
  } catch {
    // Storage can be blocked; the choice then lasts for this visit only.
  }
}

const LINE = 'px-5 max-md:px-3 in-data-agent-frame:px-2'

interface RowProps {
  taskId: string
  node: SubtaskNode
  selected: boolean
  onPick: () => void
}

function StripRow({ taskId, node, selected, onPick }: RowProps) {
  const { subtask, depth } = node
  const now = useNow(subtask.status === 'running')
  const elapsed = subtaskElapsed(subtask, now)
  return (
    <li>
      <button
        type="button"
        data-testid="subagent-row"
        aria-current={selected ? 'page' : undefined}
        onClick={() => {
          onPick()
          navigate('agents', subtaskRouteId(taskId, subtask.tool_use_id))
        }}
        className={cn(
          LINE,
          'flex w-full items-center gap-2 py-1 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:min-h-11',
          selected && 'agent-tint bg-accent',
        )}
      >
        {depth > 0 && <span aria-hidden className="shrink-0" style={{ width: depth * INDENT_PX }} />}
        <SubtaskLight status={subtask.status} />
        <span className="min-w-0 flex-1 truncate">{subtask.description}</span>
        {elapsed !== null && <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{elapsed}</span>}
      </button>
    </li>
  )
}

interface ListProps {
  taskId: string
  subtasks: readonly SubtaskBrief[]
  selected: string | null
  id?: string
  className?: string
  onPick?: () => void
}

function SubagentList({ taskId, subtasks, selected, id, className, onPick = () => undefined }: ListProps) {
  return (
    <ul id={id} className={cn('overflow-y-auto', className)}>
      {subtaskTree(subtasks).map((node) => (
        <StripRow
          key={node.subtask.tool_use_id}
          taskId={taskId}
          node={node}
          selected={node.subtask.tool_use_id === selected}
          onPick={onPick}
        />
      ))}
    </ul>
  )
}

/** "3 subagents" and a light with the count of each status. */
function SubagentCounts({ subtasks }: { subtasks: readonly SubtaskBrief[] }) {
  return (
    <>
      <Network className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0 font-semibold text-foreground">
        {subtasks.length} {subtasks.length === 1 ? 'subagent' : 'subagents'}
      </span>
      <span aria-hidden className="ml-1.5 flex min-w-0 items-center gap-3 overflow-hidden">
        {subtaskCounts(subtasks).map(({ status, count }) => (
          <span key={status} className="flex shrink-0 items-center gap-1 tabular-nums">
            <SubtaskLight status={status} />
            {count}
            <span className="in-data-agent-frame:hidden max-md:hidden">{SUBTASK_LABEL[status]}</span>
          </span>
        ))}
      </span>
    </>
  )
}

interface SubagentStripProps {
  taskId: string
  subtasks: readonly SubtaskBrief[]
  /** The subagent open in the view, marked in the list. */
  selected?: string | null
}

/** A subagent's siblings under its header: one line of counts, unfolding into one row each. */
export const SubagentStrip = memo(function SubagentStripView({
  taskId,
  subtasks,
  selected = null,
}: SubagentStripProps) {
  const [open, setOpen] = useState(() => storedOpen(taskId))
  const list = useId()
  if (subtasks.length === 0) {
    return null
  }
  const toggle = () => {
    setOpen(!open)
    storeOpen(taskId, !open)
  }
  return (
    <section aria-label="Subagents" className="shrink-0 border-b border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? list : undefined}
        aria-label={subagentsLabel(subtasks)}
        onClick={toggle}
        className={cn(
          LINE,
          'flex h-7 w-full items-center gap-1.5 text-left text-2xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:min-h-11',
        )}
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
        <SubagentCounts subtasks={subtasks} />
      </button>
      {open && (
        <SubagentList
          id={list}
          taskId={taskId}
          subtasks={subtasks}
          selected={selected}
          className="max-h-48 border-t border-border/60 in-data-agent-frame:max-h-32"
        />
      )}
    </section>
  )
})

interface SubagentsButtonProps {
  taskId: string
  subtasks: readonly SubtaskBrief[]
  /** The smaller size compact agent headers use. */
  compact?: boolean
}

/** The agent's subagents behind a header button badged with the running count; none hides it. */
export function SubagentsButton({ taskId, subtasks, compact = false }: SubagentsButtonProps) {
  const [open, setOpen] = useState(false)
  if (subtasks.length === 0) {
    return null
  }
  const badge = runningBadge(subtasks)
  const label = subagentsLabel(subtasks)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint text="Subagents this agent started">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size={compact ? 'icon-xs' : 'icon-sm'}
            className="relative"
            aria-label={label}
            data-testid="subagents-button"
          >
            <Network />
            {badge !== null && <CountBadge aria-hidden>{badge}</CountBadge>}
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        align="end"
        aria-label="Subagents"
        data-testid="subagents-popover"
        className="w-96 gap-0 p-0 max-md:w-[calc(100vw-1.5rem)]"
      >
        <div className="flex h-7 items-center gap-1.5 border-b border-border/60 px-3 text-2xs text-muted-foreground">
          <SubagentCounts subtasks={subtasks} />
        </div>
        <SubagentList
          taskId={taskId}
          subtasks={subtasks}
          selected={null}
          className="max-h-72 [&_button]:px-3"
          onPick={() => {
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

interface SubagentsSheetProps {
  taskId: string
  subtasks: readonly SubtaskBrief[]
  onClose: () => void
}

/** The agent's subagents in a bottom sheet, which the phone's actions menu opens. */
export function SubagentsSheet({ taskId, subtasks, onClose }: SubagentsSheetProps) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        aria-describedby={undefined}
        className="gap-0 p-0"
        data-testid="subagents-sheet"
      >
        <SheetTitle className="sr-only">Subagents</SheetTitle>
        <div className="flex min-h-11 items-center gap-1.5 border-b border-border/60 px-3 text-xs text-muted-foreground">
          <SubagentCounts subtasks={subtasks} />
        </div>
        <SubagentList
          taskId={taskId}
          subtasks={subtasks}
          selected={null}
          className="max-h-[60dvh] [&_button]:px-3"
          onPick={onClose}
        />
      </SheetContent>
    </Sheet>
  )
}
