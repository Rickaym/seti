import { SHELL_CONTEXT_RUNS, type MessageRow, type ShellProgress, type ShellResult } from '@seti/shared'
import { MessageSquareOff, MessageSquareShare, SquareTerminal } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { ShellDelivery } from '@/lib/transcript'
import { cn } from '@/lib/utils'
import { TrimmedText, type FullSource } from '@/panels/tasks/ToolCall'

type Stream = 'stdout' | 'stderr'

const pickStream = (row: MessageRow, stream: string) =>
  row.kind === 'shell' && (stream === 'stdout' || stream === 'stderr') ? row.payload[stream] : ''

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${String(Math.round(ms / 1000))}s`
}

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return <span className={cn('shrink-0 px-1.5 py-0.5 text-2xs font-semibold uppercase', className)}>{children}</span>
}

function outcome(result: ShellResult): { label: string; className: string } {
  if (result.ended_by === 'timeout') {
    return { label: 'timed out', className: 'bg-destructive/20 text-destructive' }
  }
  if (result.ended_by === 'user') {
    return { label: 'stopped', className: 'bg-muted text-muted-foreground' }
  }
  if (result.exit_code === 0) {
    return { label: 'exit 0', className: 'bg-success/20 text-foreground' }
  }
  const code = result.exit_code === null ? (result.signal ?? 'failed') : `exit ${String(result.exit_code)}`
  return { label: code, className: 'bg-destructive/20 text-destructive' }
}

function Frame({ command, badge, children }: { command: string; badge: ReactNode; children: ReactNode }) {
  return (
    <div className="border-l-2 border-shell bg-muted/40 font-mono text-xs" data-kind="shell">
      <div className="flex items-start gap-2 px-2 py-1.5">
        <SquareTerminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">
          <span className="text-muted-foreground select-none">$ </span>
          {command}
        </span>
        {badge}
      </div>
      <div className="space-y-2 border-t border-border px-2 py-2">{children}</div>
    </div>
  )
}

function Output({ text, stream, source }: { text: string; stream: Stream; source: FullSource | null }) {
  return (
    <div className={cn(stream === 'stderr' && 'border-l-2 border-warning pl-2')}>
      {stream === 'stderr' && <div className="text-2xs text-muted-foreground uppercase">stderr</div>}
      <TrimmedText text={text} source={source} label="Full output" className="max-h-96" />
    </div>
  )
}

const DELIVERY = {
  next: { icon: MessageSquareShare, text: 'Goes to the agent with your next message' },
  dropped: { icon: MessageSquareOff, text: `Won't reach the agent; only the newest ${String(SHELL_CONTEXT_RUNS)} go` },
} as const

/** Whether the agent gets this run with the next message, as the server's shell preface sends it. */
function DeliveryNote({ delivery }: { delivery: ShellDelivery }) {
  const { icon: Icon, text } = DELIVERY[delivery]
  return (
    <p className="flex items-center gap-1.5 font-sans text-2xs text-muted-foreground" data-testid="shell-delivery">
      <Icon className="size-3 shrink-0" />
      {text}
    </p>
  )
}

interface ShellEntryProps {
  taskId: string
  row: MessageRow
  result: ShellResult
  /** Set while the run waits for the agent's next message. */
  delivery: ShellDelivery | undefined
}

/** A finished `!` command: its command line, exit status, duration and output. */
export function ShellEntry({ taskId, row, result, delivery }: ShellEntryProps) {
  const status = outcome(result)
  const trimmed = new Set(row.trimmed)
  const source = (stream: Stream) =>
    trimmed.has(stream) ? { taskId, rowId: row.id, toolUseId: stream, pick: pickStream } : null
  const empty = result.stdout === '' && result.stderr === ''
  return (
    <Frame
      command={result.command}
      badge={
        <>
          <span className="shrink-0 text-muted-foreground">{seconds(result.duration_ms)}</span>
          <Badge className={status.className}>{status.label}</Badge>
        </>
      }
    >
      {result.stdout !== '' && <Output text={result.stdout} stream="stdout" source={source('stdout')} />}
      {result.stderr !== '' && <Output text={result.stderr} stream="stderr" source={source('stderr')} />}
      {empty && <p className="text-muted-foreground">No output.</p>}
      {delivery !== undefined && <DeliveryNote delivery={delivery} />}
    </Frame>
  )
}

function useElapsed(startedAt: string): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  return Math.max(0, now - new Date(startedAt).getTime())
}

/** The `!` command running now, with the newest part of its output. */
export function ShellLive({ progress }: { progress: ShellProgress }) {
  const elapsed = useElapsed(progress.started_at)
  const empty = progress.stdout === '' && progress.stderr === ''
  return (
    <Frame
      command={progress.command}
      badge={<Badge className="animate-pulse bg-primary text-primary-foreground">running {seconds(elapsed)}</Badge>}
    >
      {progress.stdout !== '' && <Output text={progress.stdout} stream="stdout" source={null} />}
      {progress.stderr !== '' && <Output text={progress.stderr} stream="stderr" source={null} />}
      {empty && <p className="text-muted-foreground">Waiting for output...</p>}
    </Frame>
  )
}
