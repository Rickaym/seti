import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  Plug,
  Search,
  ShieldAlert,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { type ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { useNow } from '@/hooks/useNow'
import { useSlackSummary } from '@/lib/slack-names'
import { elapsedLabel } from '@/lib/time'
import {
  commandLine,
  durationOf,
  exitCode,
  refusals,
  toolKind,
  toolName,
  toolSummary,
  type ToolKind,
} from '@/lib/tool-summary'
import {
  fullInputText,
  fullResultText,
  resultText,
  type BackgroundStatus,
  type ToolResultRef,
  type ToolUseBlock,
} from '@/lib/transcript'
import { cn } from '@/lib/utils'
import { ToolFileButton } from '@/panels/files/FileLink'
import { CallInput } from '@/panels/tasks/ToolInput'
import { TrimmedText } from '@/panels/tasks/TrimmedText'

/** The file a call that edits one changes, whose card links to it in Files. */
const touchedFile = (block: ToolUseBlock) => {
  const path = block.edit?.changes[0]?.path
  return path === '' ? undefined : path
}

const ICONS: Record<ToolKind, LucideIcon> = {
  command: SquareTerminal,
  monitor: Activity,
  read: FileText,
  edit: FilePen,
  search: Search,
  web: Globe,
  agent: Bot,
  todo: ListTodo,
  mcp: Plug,
  other: Wrench,
}

export function ToolKindIcon({ kind, className }: { kind: ToolKind; className?: string }) {
  const Icon = ICONS[kind]
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', className)} />
}

export function ToolOutput({ taskId, result }: { taskId: string; result: ToolResultRef }) {
  const source = result.trimmed ? { taskId, rowId: result.rowId, toolUseId: result.callId, pick: fullResultText } : null
  return (
    <TrimmedText
      text={resultText(result)}
      source={source}
      label="Full output"
      className={cn('max-h-96', result.failed && 'text-destructive')}
    />
  )
}

export function ToolDetails({
  className,
  resultRow,
  summary,
  children,
}: {
  className?: string
  /** The message holding the call's result, so find can show a hit in it. */
  resultRow: number | undefined
  summary: ReactNode
  children: ReactNode
}) {
  return (
    <details
      className={cn('group/tool border-l-2 border-border bg-muted/40 text-xs', className)}
      data-result-row={resultRow}
    >
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 px-2 py-1 hover:bg-muted/60 pointer-coarse:min-h-11">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open/tool:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="space-y-2 border-t border-border px-2 py-2">{children}</div>
    </details>
  )
}

/** How long a call has been running, ticking every second while it is shown. */
export function RunningFor({ since }: { since: string }) {
  const now = useNow(true)
  return <>{elapsedLabel(now - Date.parse(since))}</>
}

export function Spinner() {
  return <Loader2 aria-hidden className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
}

/** Marks a call that acts beyond this machine, which the audit log records. */
export function OutwardMark({ count }: { count?: number }) {
  const calls = count === 1 ? '1 outward call' : `${String(count)} outward calls`
  const label = count === undefined ? 'Outward call' : calls
  return (
    <Hint text={`${label}: acts beyond this machine and is recorded in the audit log`}>
      <span
        role="img"
        aria-label={label}
        data-testid="tool-outward"
        className="flex shrink-0 items-center gap-0.5 text-warning-text"
      >
        <AlertTriangle aria-hidden className="size-3" />
        {count !== undefined && count > 1 && <span className="tabular-nums">{count}</span>}
      </span>
    </Hint>
  )
}

const BACKGROUND_LABEL: Record<BackgroundStatus, string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
  killed: 'stopped',
}

interface StatusProps {
  block: ToolUseBlock
  startedAt: string
  result: ToolResultRef | undefined
  running: boolean
  background: BackgroundStatus | undefined
}

/** Running time, a failure with its exit code, or a quiet mark and duration once done. */
export function CallStatus({ block, startedAt, result, running, background }: StatusProps) {
  if (result === undefined) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground tabular-nums" data-testid="tool-running">
        {running ? (
          <>
            <Spinner />
            running <RunningFor since={startedAt} />
          </>
        ) : (
          'no result'
        )}
      </span>
    )
  }
  if (result.stopped === true) {
    return (
      <span className="shrink-0 text-muted-foreground" data-testid="tool-stopped">
        stopped
      </span>
    )
  }
  if (result.failed) {
    const code = exitCode(resultText(result))
    return (
      <span className="flex shrink-0 items-center gap-0.5 text-destructive" data-testid="tool-failed">
        <X aria-hidden className="size-3" />
        {code === null ? 'failed' : `exit ${String(code)}`}
      </span>
    )
  }
  if (background !== undefined) {
    const watching = background === 'running'
    return (
      <span
        className={cn(
          'flex shrink-0 items-center gap-1 text-muted-foreground',
          background === 'failed' && 'text-destructive',
        )}
        data-testid="tool-background"
      >
        {watching && <Spinner />}
        {watching && block.shell?.action === 'watch' ? 'watching' : BACKGROUND_LABEL[background]}
      </span>
    )
  }
  const took = durationOf(startedAt, result.at)
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground tabular-nums">
      {took}
      <Check aria-label="Done" className="size-3 opacity-60" />
    </span>
  )
}

/** The tool's icon and name, and one line saying what the call does. */
function CallName({ block }: { block: ToolUseBlock }) {
  const name = toolName(block.name)
  const summary = useSlackSummary(block) ?? toolSummary(block)
  return (
    <>
      <ToolKindIcon kind={toolKind(block)} className="size-3 text-muted-foreground" />
      <span className="min-w-0 truncate font-semibold" title={block.name}>
        {name.server !== null && <span className="font-normal text-muted-foreground">{name.server}.</span>}
        {name.name}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground"
        title={commandLine(block) ?? summary}
        data-testid="tool-summary"
      >
        {summary}
      </span>
    </>
  )
}

export interface ToolCallProps {
  taskId: string
  rowId: number
  /** When the call was made, for the running time. */
  startedAt: string
  block: ToolUseBlock
  result: ToolResultRef | undefined
  outward: boolean
  inputTrimmed: boolean
  running: boolean
  /** The background process the call started, such as a Monitor's watch. */
  background: BackgroundStatus | undefined
}

/** One call on one line; opening it shows the full input and the result. */
export function ToolCall({
  taskId,
  rowId,
  startedAt,
  block,
  result,
  outward,
  inputTrimmed,
  running,
  background,
}: ToolCallProps) {
  const failed = result?.failed === true
  const inputSource = inputTrimmed ? { taskId, rowId, toolUseId: block.callId, pick: fullInputText } : null
  const output = result ? resultText(result) : ''
  const refused = refusals(output)
  const touched = touchedFile(block)
  return (
    <ToolDetails
      className={cn(outward && 'border-warning bg-warning/10', (failed || refused.length > 0) && 'border-destructive')}
      resultRow={result?.rowId}
      summary={
        <>
          <CallName block={block} />
          {touched !== undefined && <ToolFileButton path={touched} />}
          {outward && <OutwardMark />}
          {refused.length > 0 && (
            <span
              className="flex shrink-0 items-center gap-1 font-semibold text-destructive"
              title={refused.join('\n')}
              data-testid="sandbox-blocked"
            >
              <ShieldAlert className="size-3" /> blocked
            </span>
          )}
          <CallStatus block={block} startedAt={startedAt} result={result} running={running} background={background} />
        </>
      }
    >
      <CallInput block={block} source={inputSource} taskId={taskId} />
      {result ? (
        <div className="space-y-2 border-t border-border pt-2">
          <ToolOutput taskId={taskId} result={result} />
        </div>
      ) : (
        !running && <p className="text-muted-foreground">No result was recorded for this call.</p>
      )}
    </ToolDetails>
  )
}

/** A result whose call sits in messages that are not loaded yet. */
export function OrphanResult({ taskId, result }: { taskId: string; result: ToolResultRef }) {
  return (
    <ToolDetails
      resultRow={undefined}
      summary={
        <>
          <span className="shrink-0 font-semibold">Tool output</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">call is in earlier messages</span>
        </>
      }
    >
      <ToolOutput taskId={taskId} result={result} />
    </ToolDetails>
  )
}
