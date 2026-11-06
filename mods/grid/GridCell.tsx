import {
  listedStatus,
  type AgentColor,
  type ModAgentAction as AgentAction,
  type ModAgentFrame as Frame,
  type SubtaskBrief,
  type TaskListEntry,
  type TerminalRef,
} from '@seti/mod-api'
import { ArrowLeftRight, GripVertical, Maximize2, Move, Play, X } from 'lucide-react'
import { memo, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { CellPicker } from './CellPicker'
import { gridStore } from './grid-store'
import { AgentFrame, AgentView, Button, StatusLight, UnseenDot } from './parts'
import { cn, seti } from './seti'

export interface CellProps {
  id: string
  task: TaskListEntry | null
  focused: boolean
  /** Shows the focus frame; a lone panel needs none. */
  framed: boolean
  /** Streams its agent; a paused panel shows a stand-in until it is focused. */
  live: boolean
  locked: boolean
  /** Arrow keys move and resize this panel. */
  arranging: boolean
  subId: string | null
  /** The agents to pick from, passed only while the panel shows its picker. */
  pickFrom: readonly TaskListEntry[] | null
  placed: ReadonlySet<string>
  onChanged: () => void
  onSubtasks: (taskId: string, subtasks: readonly SubtaskBrief[]) => void
  onFocusPanel: (id: string) => void
  onPick: (id: string, agent: string | null) => void
  onPicking: (id: string | null) => void
  onRemove: (id: string) => void
  onArrange: (id: string) => void
  /** Shows a terminal outside the grid, or a new shell, in this empty panel. */
  onPickTerminal: (id: string, existing?: TerminalRef) => void
}

/** A panel's frame takes its agent's colour, or the primary colour when it has none. */
function panelColour(task: TaskListEntry | null) {
  const color = task?.color ?? null
  return {
    attr: seti().agents.colorAttr(color),
    frame: color === null ? 'after:border-primary' : 'after:border-(--agent-stripe)',
  }
}

/** The strip a panel without an agent header drags by. */
function PanelBar({
  locked,
  color = null,
  children,
}: {
  locked: boolean
  color?: AgentColor | null
  children: ReactNode
}) {
  return (
    <div
      data-panel-handle=""
      {...seti().agents.colorAttr(color)}
      className={cn(
        'agent-tint agent-rule flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-1',
        !locked && 'cursor-grab',
      )}
    >
      <span aria-hidden className="flex h-6 w-4 shrink-0 items-center justify-center text-muted-foreground/70">
        {!locked && <GripVertical className="size-3.5" />}
      </span>
      {children}
    </div>
  )
}

function PausedCell({ task, locked, onResume }: { task: TaskListEntry; locked: boolean; onResume: () => void }) {
  const status = listedStatus(task)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelBar locked={locked} color={task.color}>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{task.title}</h2>
        {task.unseen && <UnseenDot />}
        <StatusLight status={status} place="grid" subagents={task.subtask_counts.running} agent={task} />
      </PanelBar>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="max-w-64 text-xs text-muted-foreground">
          Paused: this connection streams a few agents at a time, the ones you focused last.
        </p>
        <Button variant="outline" size="xs" onClick={onResume}>
          <Play />
          Resume
        </Button>
      </div>
    </div>
  )
}

const hasAgent = (event: DragEvent) => event.dataTransfer.types.includes(seti().agents.DRAG_TYPE)

const sameTask = (a: TaskListEntry | null, b: TaskListEntry | null) =>
  a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b))

/** Polls hand every task a new object; a panel whose task reads the same skips re-rendering. */
function sameCell(prev: CellProps, next: CellProps): boolean {
  const keys = Object.keys(next) as (keyof CellProps)[]
  return keys.every((key) => (key === 'task' ? sameTask(prev.task, next.task) : Object.is(prev[key], next[key])))
}

function CellBody({ props, frame }: { props: CellProps; frame: Frame }) {
  const { id, task, live, locked, subId, pickFrom, placed, onChanged, onSubtasks, onFocusPanel, onPick } = props
  const { onPickTerminal } = props
  if (task === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelBar locked={locked}>
          <p className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">Empty panel</p>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Remove panel"
            onClick={() => {
              props.onRemove(id)
            }}
          >
            <X />
          </Button>
        </PanelBar>
        {pickFrom !== null && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3">
            <CellPicker
              tasks={pickFrom}
              placed={placed}
              onPick={(picked) => {
                onPick(id, picked)
              }}
              onTerminal={(existing) => {
                onPickTerminal(id, existing)
              }}
            />
            <p className="shrink-0 text-2xs text-muted-foreground">or drag an agent here</p>
          </div>
        )}
      </div>
    )
  }
  if (!live) {
    return (
      <PausedCell
        task={task}
        locked={locked}
        onResume={() => {
          onFocusPanel(id)
        }}
      />
    )
  }
  return (
    <AgentFrame frame={frame}>
      <AgentView task={task} subId={subId} onChanged={onChanged} onSubtasks={onSubtasks} />
    </AgentFrame>
  )
}

/** The panel's own rows in its agent's More actions menu. */
function usePanelMenu({ id, task, locked, onRemove, onPicking, onArrange }: CellProps): AgentAction[] {
  const agent = task?.id ?? null
  return useMemo(
    () => [
      ...(locked
        ? []
        : [
            {
              label: 'Arrange',
              icon: Move,
              onSelect: () => {
                onArrange(id)
              },
            },
          ]),
      {
        label: 'Swap agent',
        icon: ArrowLeftRight,
        onSelect: () => {
          onPicking(id)
        },
      },
      {
        label: 'Open alone',
        icon: Maximize2,
        onSelect: () => {
          gridStore.setEnabled(false)
          if (agent !== null) {
            seti().agents.open(agent)
          }
        },
      },
      {
        label: 'Remove from grid',
        icon: X,
        onSelect: () => {
          onRemove(id)
        },
      },
    ],
    [id, locked, agent, onRemove, onPicking, onArrange],
  )
}

/** A panel: an agent view, a paused stand-in or a picker; only the focused panel takes keys. */
export const GridCell = memo(function GridCellView(props: CellProps) {
  const { id, task, focused, framed, locked, arranging, pickFrom, placed } = props
  const { onFocusPanel, onPick, onPicking } = props
  const [dropping, setDropping] = useState(false)
  const menu = usePanelMenu(props)
  const frame = useMemo<Frame>(() => ({ id, focused, draggable: !locked, menu }), [id, focused, locked, menu])

  const colour = panelColour(task)
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions --
     A panel takes focus from any press inside it, and an empty one takes agents dropped on it. */
  return (
    <section
      aria-label={task === null ? 'Empty panel' : task.title}
      data-grid-cell=""
      data-grid-panel={id}
      data-grid-focused={focused}
      {...seti().panels.markers.PANEL}
      {...seti().panels.markers.focused(focused)}
      data-grid-empty={task === null ? '' : undefined}
      {...colour.attr}
      tabIndex={-1}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-border bg-background outline-none',
        'after:pointer-events-none after:absolute after:inset-0 after:z-30',
        colour.frame,
        framed && focused && 'after:border-2',
        dropping && 'bg-primary/5 after:border-2 after:border-dashed',
        arranging && 'after:border-2 after:border-dashed',
      )}
      onFocus={() => {
        onFocusPanel(id)
      }}
      onPointerDown={() => {
        onFocusPanel(id)
      }}
      onDragOver={(event) => {
        if (task === null && hasAgent(event)) {
          setDropping(true)
        }
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
          setDropping(false)
        }
      }}
      onDrop={() => {
        setDropping(false)
      }}
    >
      <CellBody props={props} frame={frame} />
      {task !== null && pickFrom !== null && (
        <div className="absolute inset-0 z-20 flex items-start justify-center bg-background/95 p-4 pt-10">
          <CellPicker
            tasks={pickFrom}
            placed={placed}
            focusOnMount
            onPick={(picked) => {
              onPick(id, picked)
            }}
            onCancel={() => {
              onPicking(null)
            }}
          />
        </div>
      )}
      {arranging && (
        <p
          aria-hidden
          className="absolute inset-x-0 bottom-0 z-40 bg-primary px-2 py-1 text-2xs text-primary-foreground"
        >
          Arrows move, Shift+Arrows resize, Enter keeps, Esc cancels
        </p>
      )}
    </section>
  )
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions --
     End of the grid panel. */
}, sameCell)
