import {
  listedStatus,
  runningSubtasks,
  todoProgress,
  type AgentTodo,
  type ArchivedTaskEntry,
  type SubtaskBrief,
  type Task,
  type TaskListEntry,
} from '@seti/shared'
import { ArrowLeft, ChevronDown, Pin } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Hint } from '@/components/Hint'
import { DetailPane, ListPane } from '@/components/SplitPane'
import { UnsandboxedBadge } from '@/components/UnsandboxedBadge'
import { CHORDS, useChords } from '@/components/shortcuts/chords'
import { Button } from '@/components/ui/button'
import { useNarrow } from '@/hooks/useMedia'
import { useArchivedTasks, useTasks } from '@/hooks/useTasks'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { onRevealNeedsYou, storeCollapsed, storedCollapsed } from '@/lib/needs-you'
import { PANES } from '@/lib/pane-size'
import { navigate } from '@/lib/route'
import { openStartPage } from '@/lib/start-context'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { useOpenFromNeedsYou } from '@/panels/questions/useQuestionsPane'
import { bytesLabel } from '@/panels/resources/format'
import { AgentFilter } from '@/panels/tasks/AgentFilter'
import { AgentView } from '@/panels/tasks/AgentView'
import { AgentsHeader } from '@/panels/tasks/AgentsHeader'
import { ArchivedTaskDetail } from '@/panels/tasks/ArchivedTaskDetail'
import { ModAgentAccent } from '@/panels/tasks/ModAgentAccent'
import { StartPage } from '@/panels/tasks/StartPage'
import { StatusLine } from '@/panels/tasks/StatusLine'
import { ArchivedLight, StatusLight } from '@/panels/tasks/StatusPill'
import { DetailSkeleton } from '@/panels/tasks/TranscriptSkeleton'
import { UnseenDot } from '@/panels/tasks/UnseenDot'
import { AGENT_DRAG_TYPE, filterAgents, groupAgents, repoLabel, type AgentRow } from '@/panels/tasks/agent-list'
import { useActiveLayout, useLayoutPlace } from '@/panels/tasks/agents-layouts'
import { ImportSessionsDialog } from '@/panels/tasks/import/ImportSessionsDialog'
import { reasonLine } from '@/panels/tasks/status-label'
import { WorkspaceSwitcher } from '@/panels/tasks/workspaces/WorkspaceSwitcher'
import { useShownWorkspace } from '@/panels/tasks/workspaces/useShownWorkspace'
import { TerminalOr } from '@/panels/terminal/TerminalAlone'

/** The full place and the age, shown on hover since the row shows neither. */
const rowHint = (task: Task, iso: string) => `${repoLabel(task)}\n${relativeTime(iso)}`

const ROW =
  'flex w-full items-center gap-1.5 border-b border-border px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:min-h-11'

/** A mod's accent: inside the row near its left edge, over the padding so rows keep their height. */
const ACCENT = '-my-2 -ml-1.5 items-center'

interface TaskButtonProps {
  row: AgentRow
  selected: boolean
  /** A layout that takes agents shows, so the row drags onto it. */
  draggable: boolean
  place: 'list' | 'needsYou'
  onOpen: (taskId: string) => void
}

const showAgent = (taskId: string) => {
  navigate('agents', taskId)
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

/** One agent as one line, the same height whatever it holds. */
function TaskButton({ row, selected, draggable, place, onOpen }: TaskButtonProps) {
  const { task, running, status } = row
  const reason = reasonLine(task, status)
  return (
    <button
      type="button"
      {...agentColorAttr(task.color)}
      title={[rowHint(task, task.updated_at), status, reason].filter((line) => line !== null).join('\n')}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData(AGENT_DRAG_TYPE, task.id)
        event.dataTransfer.setData('text/plain', task.title)
      }}
      onClick={() => {
        onOpen(task.id)
      }}
      className={cn(ROW, 'agent-stripe', selected && (task.color === null ? 'bg-accent' : 'agent-tint'))}
    >
      <ModAgentAccent status={status} subagents={running} agent={task} place={place} className={ACCENT} />
      {task.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
      <span className={cn('min-w-0 truncate text-sm font-medium', reason === null && 'flex-1')}>{task.title}</span>
      <StatusLine text={reason} hint={false} className="min-w-[10ch] flex-1" />
      <UnsandboxedBadge task={task} />
      <TodoCount todos={task.todos} />
      {task.unseen && <UnseenDot />}
      <StatusLight status={status} place={place} subagents={running} agent={task} />
    </button>
  )
}

function ArchivedListItem({ task, selected }: { task: ArchivedTaskEntry; selected: boolean }) {
  const { files } = task.archive
  const folders = files?.state === 'bundled' ? `, folders ${bytesLabel(files.bytes)}` : ''
  return (
    <button
      type="button"
      data-task-id={task.id}
      {...agentColorAttr(task.color)}
      title={`${rowHint(task, task.archive.archived_at)}\n${bytesLabel(task.archive.stored_bytes)} compressed${folders}`}
      onClick={() => {
        navigate('agents', task.id)
      }}
      className={cn(ROW, 'agent-stripe', selected && (task.color === null ? 'bg-accent' : 'agent-tint'))}
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">{task.title}</span>
      <ArchivedLight />
    </button>
  )
}

/** The start page's id in `#agents/new`; agent ids are UUIDs, so it never names one. */
const NEW = 'new'

function StartLink({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="text-primary hover:underline"
      onClick={() => {
        openStartPage()
      }}
    >
      {label}
    </button>
  )
}

const GROUP_HEADER =
  'sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-border bg-background px-3 py-1 text-2xs font-semibold text-muted-foreground'

/** Agents whose turn failed or ended with a question, above the rest; it folds away. */
function NeedsYouGroup({ count, children }: { count: number; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(storedCollapsed)
  const id = useId()
  const header = useRef<HTMLButtonElement>(null)
  const toggle = () => {
    setCollapsed(!collapsed)
    storeCollapsed(!collapsed)
  }
  useEffect(
    () =>
      onRevealNeedsYou(() => {
        setCollapsed(false)
        storeCollapsed(false)
        header.current?.scrollIntoView({ block: 'start' })
        header.current?.focus({ preventScroll: true })
      }),
    [],
  )
  return (
    <section aria-label="Needs you">
      <button
        ref={header}
        type="button"
        aria-expanded={!collapsed}
        aria-controls={id}
        className={cn(
          GROUP_HEADER,
          'text-destructive outline-none hover:bg-accent focus-visible:bg-accent pointer-coarse:min-h-11',
        )}
        onClick={toggle}
      >
        <ChevronDown className={cn('size-3 shrink-0 transition-transform', collapsed && '-rotate-90')} aria-hidden />
        <span>Needs you</span>
        <span className="ml-auto tabular-nums" aria-label={`${String(count)} agents`}>
          {count}
        </span>
      </button>
      <div id={id} hidden={collapsed}>
        {children}
      </div>
    </section>
  )
}

/** Subtasks the open task's stream reported, fresher than the polled task list. */
interface LiveSubtasks {
  taskId: string
  subtasks: readonly SubtaskBrief[]
}

/** Active agents under a filter: those that need the user first, then the rest. */
function ActiveList({
  tasks,
  live,
  selectedId,
  draggable,
  filter,
}: {
  tasks: readonly TaskListEntry[]
  live: LiveSubtasks | null
  selectedId: string | null
  draggable: boolean
  /** The filter shows only once opened from the header; `focusTick` focuses it again. */
  filter: { open: boolean; onClose: () => void; focusTick: number }
}) {
  const [query, setQuery] = useState('')
  if (!filter.open && query !== '') {
    setQuery('')
  }
  const rows = useMemo(
    () =>
      tasks.map((task): AgentRow => {
        const fresh = live?.taskId === task.id && task.id === selectedId ? live.subtasks : null
        const running = fresh === null ? task.subtask_counts.running : runningSubtasks(fresh)
        return { task, running, status: listedStatus(task, running) }
      }),
    [tasks, live, selectedId],
  )
  const { needsYou, others } = useMemo(() => groupAgents(filterAgents(rows, query)), [rows, query])
  const fromNeedsYou = useOpenFromNeedsYou()
  const item = (place: 'list' | 'needsYou') => (row: AgentRow) => (
    <div key={row.task.id} data-task-id={row.task.id}>
      <TaskButton
        row={row}
        selected={row.task.id === selectedId}
        draggable={draggable}
        place={place}
        onOpen={place === 'needsYou' ? fromNeedsYou : showAgent}
      />
    </div>
  )
  if (tasks.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No agents yet. <StartLink label="Start one" />
      </p>
    )
  }
  return (
    <>
      {filter.open && (
        <AgentFilter query={query} onQuery={setQuery} focusTick={filter.focusTick} onClose={filter.onClose} />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {needsYou.length + others.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No agents match &quot;{query.trim()}&quot;.</p>
        )}
        {needsYou.length > 0 && <NeedsYouGroup count={needsYou.length}>{needsYou.map(item('needsYou'))}</NeedsYouGroup>}
        {others.length > 0 && (
          <section aria-label={needsYou.length > 0 ? 'Other agents' : 'Agents'}>
            {needsYou.length > 0 && <h2 className={GROUP_HEADER}>Other agents</h2>}
            {others.map(item('list'))}
          </section>
        )}
      </div>
    </>
  )
}

/** `terminalId` is the terminal the address names, shown alone or focused in a layout. */
export function TasksPanel(props: { selectedId: string | null; subId: string | null; terminalId: string | null }) {
  const { selectedId, subId, terminalId } = props
  const { tasks, loaded, error, refresh } = useTasks()
  const narrow = useNarrow()
  const layout = useActiveLayout(narrow)
  const { archived, loaded: archivedLoaded } = useArchivedTasks()
  const [showArchived, setShowArchived] = useState(false)
  const [importing, setImporting] = useState(false)
  const [searching, setSearching] = useState(false)
  const [focusTick, setFocusTick] = useState(0)
  const closeSearch = useCallback(() => {
    setSearching(false)
  }, [])
  useChords([
    {
      chord: CHORDS.filterAgents,
      run: () => {
        setShowArchived(false)
        setSearching(true)
        setFocusTick((tick) => tick + 1)
      },
    },
    {
      chord: CHORDS.importSessions,
      run: () => {
        setImporting(true)
      },
    },
  ])
  const [live, setLive] = useState<LiveSubtasks | null>(null)
  const onSubtasks = useCallback((taskId: string, subtasks: readonly SubtaskBrief[]) => {
    setLive({ taskId, subtasks })
  }, [])

  useEffect(() => {
    if (error !== null) {
      toast.error(error)
    }
  }, [error])

  const selected = tasks.find((t) => t.id === selectedId)
  const selectedArchived = selected === undefined ? archived.find((t) => t.id === selectedId) : undefined
  const view = useShownWorkspace(selected ?? selectedArchived, tasks, archived)
  const listed = view.shownId !== null
  const place = useLayoutPlace(layout, { selectedId, terminalId, listed: selected !== undefined, loaded })

  const detail = () => {
    if (selectedId === NEW || (selectedId === null && layout === null)) {
      return <StartPage />
    }
    if (layout !== null && place.inLayout) {
      const Layout = layout.view
      return (
        <Layout
          tasks={view.tasks}
          loaded={loaded && listed}
          routeId={place.routeId}
          subId={subId}
          terminalId={place.terminalId}
          onChanged={refresh}
          onSubtasks={onSubtasks}
        />
      )
    }
    if (selected) {
      return <AgentView task={selected} subId={subId} onChanged={refresh} onSubtasks={onSubtasks} />
    }
    if (selectedArchived) {
      return <ArchivedTaskDetail key={selectedArchived.id} task={selectedArchived} />
    }
    return <DetailSkeleton />
  }

  return (
    <div className="flex h-full min-h-0">
      <ListPane detailOpen={selectedId !== null} pane={PANES.agents} label="Resize agent list">
        <AgentsHeader
          narrow={narrow}
          searching={showArchived ? null : searching}
          onSearching={setSearching}
          archived={showArchived}
          onArchived={setShowArchived}
          onImport={() => {
            setImporting(true)
          }}
        />
        <WorkspaceSwitcher workspaces={view.workspaces} current={view.shown} />
        {showArchived ? (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border py-1.5 pr-1.5 pl-3">
              <span className="min-w-0 truncate text-xs text-muted-foreground">Archived, read-only</span>
              <Hint text="Back to active agents">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setShowArchived(false)
                  }}
                >
                  <ArrowLeft />
                  Active
                </Button>
              </Hint>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto" aria-label="Archived agents">
              {archivedLoaded && listed && view.archived.length === 0 && (
                <p className="p-4 text-sm text-muted-foreground">No archived agents.</p>
              )}
              {view.archived.map((t) => (
                <ArchivedListItem key={t.id} task={t} selected={t.id === selectedId} />
              ))}
            </div>
          </>
        ) : (
          listed && (
            <ActiveList
              tasks={view.tasks}
              live={live}
              selectedId={selectedId}
              draggable={layout?.acceptsAgents === true}
              filter={{ open: searching, onClose: closeSearch, focusTick }}
            />
          )
        )}
      </ListPane>
      <DetailPane detailOpen={selectedId !== null}>
        <ErrorBoundary name="This agent" resetKey={`${selectedId ?? ''}/${subId ?? ''}`}>
          <TerminalOr id={place.alone} detail={detail} />
        </ErrorBoundary>
      </DetailPane>
      {importing && (
        <ImportSessionsDialog
          onClose={() => {
            setImporting(false)
          }}
          onDone={(taskId) => {
            setImporting(false)
            refresh()
            navigate('agents', taskId)
          }}
        />
      )}
    </div>
  )
}
