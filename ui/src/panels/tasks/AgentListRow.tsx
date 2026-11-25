import { todoProgress, type AgentTodo } from '@seti/shared'
import { Archive, CornerDownRight, Pin } from 'lucide-react'
import { useState } from 'react'
import { Hint } from '@/components/Hint'
import { RuntimeBadge } from '@/components/RuntimeBadge'
import { UnsandboxedBadge } from '@/components/UnsandboxedBadge'
import { Button } from '@/components/ui/button'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { cn } from '@/lib/utils'
import { ModAgentAccent } from '@/panels/tasks/ModAgentAccent'
import { StatusLine } from '@/panels/tasks/StatusLine'
import { StatusLight } from '@/panels/tasks/StatusPill'
import { UnseenDot } from '@/panels/tasks/UnseenDot'
import { AGENT_DRAG_TYPE, ROW, rowHint, type AgentRow } from '@/panels/tasks/agent-list'
import { reasonLine } from '@/panels/tasks/status-label'
import { archiveWithUndo } from '@/panels/tasks/useArchive'

/** A mod's accent: inside the row near its left edge, over the padding so rows keep their height. */
const ACCENT = '-my-2 -ml-1.5 items-center'

/** The gap in the row that Archive takes, open while the pointer or the keyboard's focus is there. */
const GAP_ON_ROW = 'hidden group-hover/row:block group-has-focus-visible/row:block'

/** Archive where a pointer hovers: unseen but in the tab order until the row has it or focus. */
const ON_ROW =
  'pointer-events-none hidden opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-has-focus-visible/row:opacity-100 [@media(hover:hover)]:flex'

const BUSY_HINT = 'Stop the agent to archive it'

interface AgentListRowProps {
  row: AgentRow
  selected: boolean
  /** A layout that takes agents shows, so the row drags onto it. */
  draggable: boolean
  place: 'list' | 'needsYou'
  /** Archive stays on every row, for touch screens and for clearing several agents. */
  archiving: boolean
  onOpen: (taskId: string) => void
}

/** How far the agent is through its todo list, shown only while items remain. */
function TodoCount({ todos }: { todos: readonly AgentTodo[] }) {
  const { done, total } = todoProgress(todos)
  if (total === 0 || done === total) {
    return null
  }
  const counts = `${String(done)}/${String(total)}`
  return (
    <span
      data-testid="agent-todo-count"
      aria-label={`${counts} todos done`}
      className="shrink-0 text-2xs text-muted-foreground tabular-nums"
    >
      {counts}
    </span>
  )
}

/** Archive beside the row's status light, in the gap the row opens for it. */
function ArchiveButton({ row, pinned }: { row: AgentRow; pinned: boolean }) {
  const { task, status } = row
  const [pending, setPending] = useState(false)
  const busy = status === 'running' || task.status === 'running'
  const archive = async () => {
    setPending(true)
    await archiveWithUndo(task)
    setPending(false)
  }
  return (
    <Hint text={busy ? BUSY_HINT : 'Archive: leaves the list until you restore it'}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Archive ${task.title}`}
        aria-disabled={busy || pending}
        className={cn(
          'absolute inset-y-0 right-7.5 my-auto text-muted-foreground hover:bg-background pointer-coarse:size-11 dark:hover:bg-background',
          'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground',
          pinned ? 'flex' : ON_ROW,
        )}
        onClick={() => {
          if (!busy && !pending) {
            void archive()
          }
        }}
      >
        <Archive />
      </Button>
    </Hint>
  )
}

/** One agent as one line, the same height whatever it holds, with Archive at its end. */
export function AgentListRow({ row, selected, draggable, place, archiving, onOpen }: AgentListRowProps) {
  const { task, running, status } = row
  const reason = reasonLine(task, status)
  const under = row.under ?? null
  const startedBy = under === null ? null : `Started by ${under}`
  return (
    <div className="group/row relative">
      <div data-task-id={task.id}>
        <button
          type="button"
          {...agentColorAttr(task.color)}
          title={[rowHint(task, task.updated_at), status, reason, startedBy].filter((line) => line !== null).join('\n')}
          draggable={draggable}
          onDragStart={(event) => {
            event.dataTransfer.setData(AGENT_DRAG_TYPE, task.id)
            event.dataTransfer.setData('text/plain', task.title)
          }}
          onClick={() => {
            onOpen(task.id)
          }}
          className={cn(
            ROW,
            'agent-stripe group-hover/row:bg-accent',
            selected && (task.color === null ? 'bg-accent' : 'agent-tint'),
            under !== null && 'pl-5',
          )}
        >
          <ModAgentAccent status={status} subagents={running} agent={task} place={place} className={ACCENT} />
          {startedBy !== null && (
            <CornerDownRight
              data-testid="agent-delegate-mark"
              className="size-3 shrink-0 text-muted-foreground"
              aria-label={startedBy}
            />
          )}
          {task.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
          <span className={cn('min-w-0 truncate text-sm font-medium', reason === null && 'flex-1')}>{task.title}</span>
          <StatusLine text={reason} hint={false} className="min-w-[10ch] flex-1" />
          <UnsandboxedBadge task={task} />
          <RuntimeBadge task={task} />
          <TodoCount todos={task.todos} />
          {task.unseen && <UnseenDot />}
          <span aria-hidden className={cn('w-6 shrink-0 pointer-coarse:w-11', archiving ? 'block' : GAP_ON_ROW)} />
          <StatusLight status={status} place={place} subagents={running} agent={task} />
        </button>
      </div>
      <ArchiveButton row={row} pinned={archiving} />
    </div>
  )
}
