import { listedStatus, type TaskListEntry } from '@seti/shared'
import { Check, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { cn } from '@/lib/utils'
import { ModAgentAccent } from '@/panels/tasks/ModAgentAccent'
import { StatusLine } from '@/panels/tasks/StatusLine'
import { StatusLight } from '@/panels/tasks/StatusPill'
import { UnseenDot } from '@/panels/tasks/UnseenDot'
import { filterAgents, groupAgents, repoLabel, type AgentRow } from '@/panels/tasks/agent-list'
import { reasonLine } from '@/panels/tasks/status-label'

const ROW =
  'flex w-full min-h-11 items-center gap-1.5 border-b border-border px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'

const GROUP_HEADER =
  'sticky top-0 z-10 border-b border-border bg-background px-3 py-1 text-2xs font-semibold text-muted-foreground'

const newestFirst = (a: AgentRow, b: AgentRow) => b.task.updated_at.localeCompare(a.task.updated_at)

interface RowProps {
  row: AgentRow
  picked: boolean
  place: 'list' | 'needsYou'
  onPick: (taskId: string) => void
}

/** One agent as the sidebar shows it: colour, mod accent, title, reason line and status. */
function AgentOption({ row, picked, place, onPick }: RowProps) {
  const { task, running, status } = row
  const reason = reasonLine(task, status)
  return (
    <button
      type="button"
      role="radio"
      aria-checked={picked}
      {...agentColorAttr(task.color)}
      title={repoLabel(task)}
      onClick={() => {
        onPick(task.id)
      }}
      className={cn(ROW, 'agent-stripe', picked && (task.color === null ? 'bg-accent' : 'agent-tint'))}
    >
      <ModAgentAccent status={status} subagents={running} agent={task} place={place} className="-my-2 -ml-1.5" />
      <span className={cn('min-w-0 truncate text-sm font-medium', reason === null && 'flex-1')}>{task.title}</span>
      <StatusLine text={reason} hint={false} className="min-w-[10ch] flex-1" />
      {task.unseen && <UnseenDot />}
      {picked && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
      <StatusLight status={status} place={place} subagents={running} agent={task} />
    </button>
  )
}

interface PickerProps {
  tasks: readonly TaskListEntry[]
  picked: string | null
  onPick: (taskId: string) => void
  onNewAgent: () => void
  /** Why New agent waits, such as files still uploading; null when it can go. */
  newAgentBlocked: string | null
}

/** Where the share goes: an agent, those that need the user and the latest first, or a new one. */
export function AgentPicker({ tasks, picked, onPick, onNewAgent, newAgentBlocked }: PickerProps) {
  const [query, setQuery] = useState('')
  const rows = useMemo(
    () =>
      tasks.map((task): AgentRow => {
        const running = task.subtask_counts.running
        return { task, running, status: listedStatus(task, running) }
      }),
    [tasks],
  )
  const { needsYou, others } = useMemo(() => groupAgents(filterAgents(rows, query)), [rows, query])
  const option = (place: 'list' | 'needsYou') => (row: AgentRow) => (
    <AgentOption key={row.task.id} row={row} picked={row.task.id === picked} place={place} onPick={onPick} />
  )
  return (
    <section aria-label="Send to" className="flex min-h-0 flex-col border border-border bg-card">
      <div className="relative border-b border-border px-3 py-1.5">
        <Search className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Search agents"
          placeholder="Search agents"
          className="h-8 pl-7 pointer-coarse:h-10"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
          }}
        />
      </div>
      <button
        type="button"
        title={newAgentBlocked ?? 'Start a new agent with this share'}
        disabled={newAgentBlocked !== null}
        onClick={onNewAgent}
        className={cn(ROW, 'text-sm font-medium text-primary disabled:opacity-50')}
      >
        <Plus className="size-4 shrink-0" aria-hidden />
        New agent
      </button>
      <div role="radiogroup" aria-label="Agents" className="min-h-0 flex-1 overflow-y-auto">
        {tasks.length > 0 && needsYou.length + others.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">No agents match &quot;{query.trim()}&quot;.</p>
        )}
        {needsYou.length > 0 && (
          <div role="group" aria-label="Needs you">
            <p className={cn(GROUP_HEADER, 'text-destructive')}>Needs you</p>
            {needsYou.map(option('needsYou'))}
          </div>
        )}
        {others.length > 0 && (
          <div role="group" aria-label="Recent">
            {needsYou.length > 0 && <p className={GROUP_HEADER}>Recent</p>}
            {others.toSorted(newestFirst).map(option('list'))}
          </div>
        )}
      </div>
    </section>
  )
}
