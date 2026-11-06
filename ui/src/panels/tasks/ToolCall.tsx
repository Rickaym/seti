import { type MessageRow, jsonText, type CodeLanguage } from '@seti/shared'
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
  Maximize2,
  Plug,
  Search,
  ShieldAlert,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { CODE_COPY, CODE_COPY_ROOM, CopyIconButton } from '@/components/CopyButton'
import { Hint } from '@/components/Hint'
import { HighlightedCode } from '@/components/highlight/HighlightedCode'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/useNow'
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
  fullCommandText,
  fullInputText,
  fullResultText,
  inputString,
  resultText,
  type BackgroundStatus,
  type ToolResultRef,
  type ToolUseBlock,
} from '@/lib/transcript'
import { cn } from '@/lib/utils'
import { ToolFileButton } from '@/panels/files/FileLink'

/** Tools that write a file, whose card links to it in Files. */
const FILE_TOOLS: Partial<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

const touchedFile = (block: ToolUseBlock) => {
  const key = FILE_TOOLS[block.name]
  return key === undefined ? undefined : inputString(block.input, key)
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

export interface FullSource {
  taskId: string
  rowId: number
  toolUseId: string
  pick: (row: MessageRow, toolUseId: string) => string
}

interface TrimmedTextProps {
  text: string
  /** Where to fetch the full text from, or null when `text` is complete. */
  source: FullSource | null
  label: string
  className: string
  /** The copy button's name, such as Copy command. */
  copy?: string
  /** Colours the text as this language; left out, JSON is found, indented and coloured. */
  language?: CodeLanguage
}

/** The text to show and its language: JSON comes back indented when no language is given. */
function shownCode(text: string, language: CodeLanguage | undefined): { code: string; language: CodeLanguage | null } {
  if (language !== undefined) {
    return { code: text, language }
  }
  const json = jsonText(text)
  return json === null ? { code: text, language: null } : { code: json, language: 'json' }
}

export function TrimmedText({ text, source, label, className, copy = 'Copy code', language }: TrimmedTextProps) {
  const [full, setFull] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const shown = useMemo(() => shownCode(full ?? text, language), [full, text, language])

  const load = async (from: FullSource) => {
    setLoading(true)
    try {
      const row = await apiGet<MessageRow>(`/tasks/${from.taskId}/messages/${String(from.rowId)}`)
      setFull(from.pick(row, from.toolUseId))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="group/code relative">
        <pre className={cn('overflow-auto break-all whitespace-pre-wrap', CODE_COPY_ROOM, className)}>
          <HighlightedCode code={shown.code} language={shown.language} />
        </pre>
        <CopyIconButton text={shown.code} label={copy} className={CODE_COPY} />
      </div>
      {source !== null && full === null && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>Trimmed for display.</span>
          <Button variant="outline" size="xs" disabled={loading} onClick={() => void load(source)}>
            <Maximize2 />
            {loading ? 'Loading...' : label}
          </Button>
        </div>
      )}
    </>
  )
}

export function ToolOutput({ taskId, result }: { taskId: string; result: ToolResultRef }) {
  const source = result.trimmed
    ? { taskId, rowId: result.rowId, toolUseId: result.block.tool_use_id, pick: fullResultText }
    : null
  return (
    <TrimmedText
      text={resultText(result.block.content)}
      source={source}
      label="Full output"
      className={cn('max-h-96', result.block.is_error === true && 'text-destructive')}
    />
  )
}

function ToolDetails({
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
function CallStatus({ block, startedAt, result, running, background }: StatusProps) {
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
  if (result.block.is_error === true) {
    const code = exitCode(resultText(result.block.content))
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
        {watching && block.name === 'Monitor' ? 'watching' : BACKGROUND_LABEL[background]}
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

const COMMAND_KEYS = new Set(['command', 'description'])

/** The input of a shell call: its description, the full command to copy, and any other options. */
function CommandInput({ block, source }: { block: ToolUseBlock; source: FullSource | null }) {
  const command = inputString(block.input, 'command') ?? ''
  const description = inputString(block.input, 'description')
  const options =
    typeof block.input === 'object' && block.input !== null
      ? Object.entries(block.input).filter(([key]) => !COMMAND_KEYS.has(key))
      : []
  return (
    <>
      {description !== undefined && <p className="text-muted-foreground">{description}</p>}
      <TrimmedText
        text={command}
        source={source === null ? null : { ...source, pick: fullCommandText }}
        label="Full command"
        className="max-h-64 border border-border bg-background/60 py-1.5 pr-8 pl-2"
        copy="Copy command"
        language="bash"
      />
      {options.length > 0 && (
        <p className="text-muted-foreground">
          {options.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(' | ')}
        </p>
      )}
    </>
  )
}

/** The tool's icon and name, and one line saying what the call does. */
function CallName({ block }: { block: ToolUseBlock }) {
  const name = toolName(block.name)
  const summary = toolSummary(block)
  return (
    <>
      <ToolKindIcon kind={toolKind(block.name)} className="size-3 text-muted-foreground" />
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

function CallInput({ block, source }: { block: ToolUseBlock; source: FullSource | null }) {
  if (inputString(block.input, 'command') !== undefined) {
    return <CommandInput block={block} source={source} />
  }
  return (
    <TrimmedText text={JSON.stringify(block.input, null, 2)} source={source} label="Full input" className="max-h-64" />
  )
}

interface ToolCallProps {
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
  const failed = result?.block.is_error === true
  const inputSource = inputTrimmed ? { taskId, rowId, toolUseId: block.id, pick: fullInputText } : null
  const output = result ? resultText(result.block.content) : ''
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
      <CallInput block={block} source={inputSource} />
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
