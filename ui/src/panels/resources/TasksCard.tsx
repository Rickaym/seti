import type { AnomalyRule, HistoryPoint, Resources, TaskProcess } from '@seti/shared'
import { OctagonAlert, ShieldOff, TriangleAlert } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Sparkline } from '@/components/Sparkline'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useNarrow } from '@/hooks/useMedia'
import { cn } from '@/lib/utils'
import { StopTurnButton } from '@/panels/resources/StopTurnButton'
import { ageLabel, bytesLabel, percentLabel } from '@/panels/resources/format'
import { SettingsCard } from '@/panels/settings/layout'

const FLAG_LABEL: Record<AnomalyRule, string> = {
  hang: 'Hung tool call',
  task_memory: 'High memory',
  host_memory: 'Host memory',
  swap: 'Swap',
  disk: 'Disk',
  load: 'Load',
  down: 'Down',
}

const UNSANDBOXED = 'Unsandboxed: commands run with full access to this machine'

const isCritical = (row: TaskProcess) => row.flags.includes('hang')

function rowTone(row: TaskProcess): string {
  if (isCritical(row)) {
    return 'bg-destructive/10 hover:bg-destructive/15'
  }
  return row.flags.length > 0 ? 'bg-warning/10 hover:bg-warning/15' : ''
}

function Flags({ row }: { row: TaskProcess }) {
  if (row.flags.length === 0) {
    return null
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {row.flags.map((flag) => {
        const critical = flag === 'hang'
        const Icon = critical ? OctagonAlert : TriangleAlert
        return (
          <span
            key={flag}
            className={cn(
              'inline-flex items-center gap-0.5 font-semibold',
              critical ? 'text-destructive' : 'text-warning-text',
            )}
          >
            <Icon className="size-3" aria-hidden />
            {FLAG_LABEL[flag]}
          </span>
        )
      })}
    </span>
  )
}

function TaskTitle({ row }: { row: TaskProcess }) {
  const { task } = row
  if (task === null) {
    return <span className="text-muted-foreground">Claude Code without an agent (pid {row.pid})</span>
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2">
      <a href={`#agents/${task.id}`} className="min-w-0 truncate font-medium text-primary hover:underline">
        {task.title}
      </a>
      <span className="text-muted-foreground">{task.status}</span>
      {!task.sandboxed && (
        <Hint text={UNSANDBOXED}>
          <span role="img" aria-label={UNSANDBOXED} className="flex shrink-0 items-center text-warning-text">
            <ShieldOff className="size-3" aria-hidden />
          </span>
        </Hint>
      )}
    </span>
  )
}

function Running({ row }: { row: TaskProcess }) {
  const { tool, children } = row
  const names = children.map((child) => child.name).join(', ')
  return (
    <div className="min-w-0">
      {tool !== null && (
        <div className="truncate" title={tool.command ?? tool.name}>
          <span className="text-muted-foreground">
            {tool.name} {ageLabel(tool.age_s)}
          </span>
          {tool.command !== null && <span className="ml-1.5 font-mono">{tool.command}</span>}
        </div>
      )}
      <div
        className="truncate text-muted-foreground"
        title={children.map((c) => `${c.name} (${String(c.pid)})`).join(', ')}
      >
        {names === '' ? 'no child process' : names}
      </div>
    </div>
  )
}

const canStop = (row: TaskProcess) => row.flags.length > 0 && row.task?.status === 'running'

function StopCell({ row }: { row: TaskProcess }) {
  return row.task !== null && canStop(row) ? <StopTurnButton taskId={row.task.id} title={row.task.title} /> : null
}

function memoryText(row: TaskProcess): string {
  return row.swap_bytes > 0
    ? `${bytesLabel(row.rss_bytes)} +${bytesLabel(row.swap_bytes)} swap`
    : bytesLabel(row.rss_bytes)
}

function TaskTable({ rows }: { rows: readonly TaskProcess[] }) {
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[32%]">Agent</TableHead>
          <TableHead className="w-[140px] text-right">Memory</TableHead>
          <TableHead className="w-[60px] text-right">CPU</TableHead>
          <TableHead className="w-[64px] text-right">Threads</TableHead>
          <TableHead className="w-[64px] text-right">Age</TableHead>
          <TableHead>Running</TableHead>
          <TableHead className="w-[76px]" aria-label="Actions" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.pid} aria-label={row.task?.title ?? `pid ${String(row.pid)}`} className={rowTone(row)}>
            <TableCell className="align-top whitespace-normal">
              <TaskTitle row={row} />
              <Flags row={row} />
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">{memoryText(row)}</TableCell>
            <TableCell className="text-right align-top tabular-nums">{percentLabel(row.cpu_percent)}</TableCell>
            <TableCell className="text-right align-top tabular-nums">{row.threads}</TableCell>
            <TableCell className="text-right align-top tabular-nums">{ageLabel(row.age_s)}</TableCell>
            <TableCell className="align-top">
              <Running row={row} />
            </TableCell>
            <TableCell className="text-right align-top">
              <StopCell row={row} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function TaskList({ rows }: { rows: readonly TaskProcess[] }) {
  return (
    <ul>
      {rows.map((row) => (
        <li
          key={row.pid}
          aria-label={row.task?.title ?? `pid ${String(row.pid)}`}
          className={cn('space-y-1 border-b border-border px-3 py-2 last:border-b-0', rowTone(row))}
        >
          <TaskTitle row={row} />
          <Flags row={row} />
          <div className="flex flex-wrap gap-x-3 text-muted-foreground tabular-nums">
            <span>{memoryText(row)}</span>
            <span>{percentLabel(row.cpu_percent)} CPU</span>
            <span>{row.threads} threads</span>
            <span>{ageLabel(row.age_s)}</span>
          </div>
          <Running row={row} />
          {canStop(row) && (
            <div>
              <StopCell row={row} />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function Totals({ totals, history }: { totals: Resources['totals']; history: readonly HistoryPoint[] }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,240px)] items-center gap-4 border-b border-border px-3 py-2 max-md:grid-cols-1 max-md:gap-2">
      <div className="text-muted-foreground tabular-nums">
        <span className="font-semibold text-foreground">{bytesLabel(totals.rss_bytes)}</span> in {totals.processes}{' '}
        {totals.processes === 1 ? 'process' : 'processes'}, {percentLabel(totals.cpu_percent)} CPU,{' '}
        {bytesLabel(totals.swap_bytes)} swapped
      </div>
      <Sparkline
        label="Agent memory, last hour"
        points={history.map((p) => ({ at: p.at, value: p.task_rss_bytes }))}
        format={bytesLabel}
      />
    </div>
  )
}

export function TasksCard({ resources }: { resources: Resources }) {
  const narrow = useNarrow()
  const rows = resources.tasks
  return (
    <SettingsCard title="Agents">
      <Totals totals={resources.totals} history={resources.history} />
      {rows.length === 0 && <p className="px-3 py-4 text-muted-foreground">No Claude Code process is open.</p>}
      {rows.length > 0 && (narrow ? <TaskList rows={rows} /> : <TaskTable rows={rows} />)}
    </SettingsCard>
  )
}
