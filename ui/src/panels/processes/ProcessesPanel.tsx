import type {
  AgentProcess,
  AgentProcesses,
  AgentProcessKind,
  BackgroundShell,
  BackgroundShellStatus,
  ShellOutput,
  ShellStopCause,
} from '@seti/shared'
import { ChevronRight, SquareTerminal, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { CountBadge } from '@/components/CountBadge'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Hint } from '@/components/Hint'
import { PaneSplitter } from '@/components/resize/ResizablePane'
import { usePaneResize } from '@/components/resize/usePaneResize'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useNow } from '@/hooks/useNow'
import { PANES } from '@/lib/pane-size'
import { cn } from '@/lib/utils'
import { WIDE_BUTTON, WIDE_LABEL } from '@/lib/wide-label'
import { ageLabel, bytesLabel, percentLabel } from '@/panels/resources/format'
import { CpuRow } from './CpuRow'
import { MemoryRow } from './MemoryRow'
import { StopButton } from './StopButton'
import { TerminalRow } from './TerminalRow'
import { OPEN_POLL_MS, processesLabel, type AgentProcessesState } from './useAgentProcesses'
import { usePolledGet } from './usePolledGet'

const PILL = 'shrink-0 px-1.5 py-0.5 text-2xs font-semibold uppercase'

const SHELL_STYLE: Record<BackgroundShellStatus, string> = {
  running: 'bg-primary text-primary-foreground animate-pulse',
  completed: 'bg-success/20 text-foreground',
  failed: 'bg-destructive/20 text-destructive',
  killed: 'bg-muted text-muted-foreground',
}

const SHELL_LABEL: Record<BackgroundShellStatus, string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

const CAUSE_LABEL: Record<ShellStopCause, string> = {
  time_limit: 'time limit',
  low_memory: 'low memory',
}

const CAUSE_HINT: Record<ShellStopCause, string> = {
  time_limit: 'Claude Code stopped it at its background time limit and told the agent',
  low_memory: 'Claude Code stopped it because the host ran low on memory and told the agent',
}

function ShellPill({ shell }: { shell: BackgroundShell }) {
  const cause = shell.stop_cause
  if (cause === null) {
    return <span className={cn(PILL, SHELL_STYLE[shell.status])}>{SHELL_LABEL[shell.status]}</span>
  }
  return (
    <Hint text={CAUSE_HINT[cause]}>
      <span className={cn(PILL, 'bg-warning/20 text-foreground')}>{CAUSE_LABEL[cause]}</span>
    </Hint>
  )
}

const KIND_LABEL: Partial<Record<AgentProcessKind, string>> = { agent: 'Claude Code', seti: 'Seti', tool: 'Tool' }

const KIND_HINT: Partial<Record<AgentProcessKind, string>> = {
  agent: "The agent's Claude Code process; stop the agent or end its session instead",
  seti: 'Seti runs this for the agent: its sandbox, or the bridge to its egress proxy',
  tool: 'Started by Claude Code itself, such as an MCP server or a language server',
}

function shellElapsed(shell: BackgroundShell, now: number): string {
  const end = shell.ended_at === null ? now : Date.parse(shell.ended_at)
  return ageLabel(Math.max(0, (end - Date.parse(shell.started_at)) / 1000))
}

function ShellOutputView({ taskId, shell, live }: { taskId: string; shell: BackgroundShell; live: boolean }) {
  const path = `/tasks/${taskId}/shells/${shell.id}/output`
  const { data, error } = usePolledGet<ShellOutput>(path, live ? OPEN_POLL_MS : 60 * 60_000)
  if (error !== null && data === undefined) {
    return <p className="px-2 pb-2 text-2xs text-destructive">{error}</p>
  }
  if (data === undefined) {
    return <p className="px-2 pb-2 text-2xs text-muted-foreground">Loading output...</p>
  }
  if (data.text === '') {
    return <p className="px-2 pb-2 text-2xs text-muted-foreground">No output.</p>
  }
  return (
    <div className="px-2 pb-2">
      {data.truncated && (
        <p className="mb-1 text-2xs text-muted-foreground">Last lines of {bytesLabel(data.size_bytes)} of output</p>
      )}
      <pre
        aria-label={`Output of ${shell.description ?? shell.id}`}
        className="max-h-72 overflow-auto bg-muted/50 px-2 py-1.5 font-mono text-2xs whitespace-pre-wrap break-all"
      >
        {data.text}
      </pre>
    </div>
  )
}

interface ShellRowProps {
  taskId: string
  shell: BackgroundShell
  now: number
  onStop: (shell: BackgroundShell) => Promise<void>
}

function ShellRow({ taskId, shell, now, onStop }: ShellRowProps) {
  const [open, setOpen] = useState(false)
  const title = shell.description ?? shell.command
  return (
    <li data-testid="shell-row" className="border border-border">
      <div className="flex items-start gap-2 p-2">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-expanded={open}
          aria-label={open ? `Hide output of ${title}` : `Show output of ${title}`}
          onClick={() => {
            setOpen(!open)
          }}
        >
          <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
        </Button>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <ShellPill shell={shell} />
            <span className="min-w-0 truncate text-xs font-medium">{title}</span>
          </div>
          <code className="block truncate font-mono text-2xs text-muted-foreground" title={shell.command}>
            {shell.command}
          </code>
          <div className="flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
            <span className="tabular-nums">{shellElapsed(shell, now)}</span>
            <span>{shell.tool}</span>
            {shell.pid !== null && <span className="tabular-nums">pid {shell.pid}</span>}
            {shell.exit_code !== null && <span className="tabular-nums">exit {shell.exit_code}</span>}
            {shell.subagent && <span>subagent</span>}
          </div>
        </div>
        {shell.status === 'running' && (
          <StopButton
            label={`Stop ${title}`}
            hint="Stop this background shell through Claude Code; the agent is told"
            onStop={async () => onStop(shell)}
          />
        )}
      </div>
      {open && shell.has_output && <ShellOutputView taskId={taskId} shell={shell} live={shell.status === 'running'} />}
      {open && !shell.has_output && <p className="px-2 pb-2 text-2xs text-muted-foreground">No output file.</p>}
    </li>
  )
}

function ProcessRow({ process, onStop }: { process: AgentProcess; onStop: (p: AgentProcess) => Promise<void> }) {
  const label = KIND_LABEL[process.kind]
  const helper = process.kind === 'seti'
  return (
    <li
      data-testid="process-row"
      className={cn('flex items-center gap-2 py-1 pr-1 text-2xs', helper && 'text-muted-foreground')}
      style={{ paddingLeft: `${String(Math.min(process.depth, 8) * 12)}px` }}
    >
      <span
        className="w-16 shrink-0 font-mono whitespace-nowrap text-muted-foreground tabular-nums"
        title={`Host pid ${String(process.pid)}`}
      >
        {process.ns_pid ?? process.pid}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono" title={process.command}>
        {process.command}
      </span>
      {label !== undefined && (
        <Hint text={KIND_HINT[process.kind] ?? label}>
          <span className="shrink-0 border border-border px-1 text-2xs text-muted-foreground">{label}</span>
        </Hint>
      )}
      <span className="w-10 shrink-0 text-right tabular-nums" title="CPU">
        {percentLabel(process.cpu_percent)}
      </span>
      <span className="w-14 shrink-0 text-right tabular-nums max-sm:hidden" title="Memory">
        {bytesLabel(process.rss_bytes)}
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums max-sm:hidden" title="Running for">
        {ageLabel(process.elapsed_s)}
      </span>
      <span className="w-7 shrink-0 sm:w-14">
        {(process.kind === 'command' || process.kind === 'tool') && (
          <StopButton
            label={`Stop process ${String(process.ns_pid ?? process.pid)}`}
            hint="Stop this process and everything it started: SIGTERM, then SIGKILL after 3 seconds"
            onStop={async () => onStop(process)}
          />
        )}
      </span>
    </li>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

interface PanelBodyProps {
  taskId: string
  view: AgentProcesses | undefined
  error: string | null
  refresh: () => void
}

function PanelBody({ taskId, view, error, refresh }: PanelBodyProps) {
  const now = useNow(true)
  const stop = async (path: string, body: unknown, done: string) => {
    try {
      await apiPost(path, body)
      toast.success(done)
    } catch (e) {
      toast.error(errorText(e))
    }
    refresh()
  }
  if (view === undefined) {
    return <p className="p-3 text-xs text-muted-foreground">{error ?? 'Loading processes...'}</p>
  }
  const others = view.processes.filter((p) => p.shell_id === null)
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
      {view.memory.length > 0 && (
        <Section title="Memory">
          <ul className="space-y-3">
            {view.memory.map((scope) => (
              <MemoryRow key={scope.unit} scope={scope} />
            ))}
          </ul>
        </Section>
      )}
      {view.cpu.length > 0 && (
        <Section title="CPU">
          <ul className="space-y-3">
            {view.cpu.map((scope) => (
              <CpuRow key={scope.unit} scope={scope} />
            ))}
          </ul>
        </Section>
      )}
      {view.terminals.length > 0 && (
        <Section title="Terminals">
          <ul className="space-y-2">
            {view.terminals.map((terminal) => (
              <li key={terminal.id}>
                <TerminalRow
                  terminal={terminal}
                  now={now}
                  onStop={async () => stop(`/terminals/${terminal.id}/stop`, {}, 'Stopped the terminal')}
                />
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Background shells">
        {view.shells.length === 0 ? (
          <p className="text-xs text-muted-foreground">The agent has not run commands in the background.</p>
        ) : (
          <ul className="space-y-2">
            {[...view.shells].reverse().map((shell) => (
              <ShellRow
                key={shell.id}
                taskId={taskId}
                shell={shell}
                now={now}
                onStop={async (s) =>
                  stop(`/tasks/${taskId}/shells/${s.id}/stop`, {}, `Stopped ${s.description ?? s.id}`)
                }
              />
            ))}
          </ul>
        )}
      </Section>
      <Section title="Processes">
        {others.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {view.open ? 'No other processes run for this agent.' : 'The agent has no Claude Code process open.'}
          </p>
        ) : (
          <>
            <div aria-hidden="true" className="flex items-center gap-2 pr-1 text-2xs text-muted-foreground uppercase">
              <span className="w-16 shrink-0">pid</span>
              <span className="flex-1">command</span>
              <span className="w-10 shrink-0 text-right">cpu</span>
              <span className="w-14 shrink-0 text-right max-sm:hidden">mem</span>
              <span className="w-12 shrink-0 text-right max-sm:hidden">time</span>
              <span className="w-7 shrink-0 sm:w-14" />
            </div>
            <ul aria-label="Process tree">
              {others.map((p) => (
                <ProcessRow
                  key={`${String(p.pid)}:${String(p.start_ticks)}`}
                  process={p}
                  onStop={async (target) =>
                    stop(
                      `/tasks/${taskId}/processes/stop`,
                      { pid: target.pid, start_ticks: target.start_ticks },
                      `Stopped ${target.name} (${String(target.ns_pid ?? target.pid)})`,
                    )
                  }
                />
              ))}
            </ul>
          </>
        )}
      </Section>
      {error !== null && <p className="text-2xs text-destructive">{error}</p>}
    </div>
  )
}

/** The header button that opens the processes panel; its badge counts what runs. */
export function ProcessesButton({ processes }: { processes: AgentProcessesState }) {
  const { running } = processes
  return (
    <Hint text="Processes: background shells and commands the agent started">
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn('relative', WIDE_BUTTON)}
        aria-label={processesLabel(running)}
        aria-pressed={processes.open}
        onClick={() => {
          processes.setOpen(true)
        }}
      >
        <SquareTerminal />
        <span className={WIDE_LABEL}>Processes</span>
        {running > 0 && <CountBadge data-testid="processes-badge">{running}</CountBadge>}
      </Button>
    </Hint>
  )
}

/** The agent's background shells and live processes, with output and a stop button for each. */
export function ProcessesSheet({ taskId, processes }: { taskId: string; processes: AgentProcessesState }) {
  const { polled } = processes
  const sheet = useRef<HTMLDivElement>(null)
  const pane = usePaneResize(sheet, PANES.processes, 'end')
  return (
    <Sheet open={processes.open} onOpenChange={processes.setOpen}>
      <SheetContent
        ref={sheet}
        side="right"
        showCloseButton={false}
        style={pane.style}
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none data-[side=right]:md:w-(--pane-w) data-[side=right]:md:max-w-(--pane-max)"
      >
        <PaneSplitter label="Resize processes" side="end" control={pane.control} />
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <SheetTitle className="text-sm font-semibold">Processes</SheetTitle>
          {polled.data?.sandboxed === true && <span className="text-2xs text-muted-foreground">sandbox pids</span>}
          <SheetDescription className="sr-only">
            Background shells and processes the agent started, with output and a stop button for each
          </SheetDescription>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Close processes"
            onClick={() => {
              processes.setOpen(false)
            }}
          >
            <X />
          </Button>
        </div>
        <ErrorBoundary name="Processes" resetKey={taskId}>
          <PanelBody taskId={taskId} view={polled.data} error={polled.error} refresh={polled.refresh} />
        </ErrorBoundary>
      </SheetContent>
    </Sheet>
  )
}
