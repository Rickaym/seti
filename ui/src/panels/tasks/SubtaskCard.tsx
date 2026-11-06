import type { Subtask, SubtaskBrief, SubtaskStatus } from '@seti/shared'
import { ArrowUpRight, Bot, ChevronRight, FileText, GitPullRequest } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useNow } from '@/hooks/useNow'
import { prShortLabel } from '@/lib/pr-number'
import { navigate } from '@/lib/route'
import { progressLine, subtaskElapsed, subtaskRouteId } from '@/lib/subtasks'
import { fullInputText, inputString, type ToolResultRef, type ToolUseBlock } from '@/lib/transcript'
import { cn } from '@/lib/utils'
import { SubtaskPill } from '@/panels/tasks/StatusPill'
import { ToolOutput, TrimmedText } from '@/panels/tasks/ToolCall'

function provisionalStatus(result: ToolResultRef | undefined): SubtaskStatus {
  if (result === undefined) {
    return 'running'
  }
  return result.block.is_error === true ? 'failed' : 'completed'
}

/** What the card shows before the task's stream has reported on this subagent. */
function provisional(block: ToolUseBlock, result: ToolResultRef | undefined, rowId: number, at: string): SubtaskBrief {
  const status = provisionalStatus(result)
  return {
    tool_use_id: block.id,
    tool_use_ids: [block.id],
    parent_tool_use_id: null,
    message_id: rowId,
    sdk_task_id: null,
    description: inputString(block.input, 'description') ?? 'Subagent',
    subagent_type: inputString(block.input, 'subagent_type') ?? null,
    background: false,
    status,
    progress: null,
    usage: null,
    started_at: at,
    ended_at: null,
    summary: null,
    pr_urls: [],
  }
}

/** The final report of a background subagent, fetched when first shown. */
function BackgroundReport({ taskId, toolUseId }: { taskId: string; toolUseId: string }) {
  const [report, setReport] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = async () => {
    setLoading(true)
    try {
      const subtask = await apiGet<Subtask>(`/tasks/${taskId}/subtasks/${toolUseId}`)
      setReport(subtask.result ?? 'The subagent reported nothing.')
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setLoading(false)
    }
  }
  if (report !== null) {
    return <pre className="max-h-96 overflow-auto break-all whitespace-pre-wrap">{report}</pre>
  }
  return (
    <Button variant="outline" size="xs" disabled={loading} onClick={() => void load()}>
      <FileText />
      {loading ? 'Loading...' : 'Report'}
    </Button>
  )
}

function CardReport({
  taskId,
  brief,
  result,
}: {
  taskId: string
  brief: SubtaskBrief
  result: ToolResultRef | undefined
}) {
  if (brief.status === 'running' || brief.status === 'unknown') {
    const note = brief.status === 'running' ? 'No report yet.' : 'No report was recorded.'
    return <p className="text-muted-foreground">{note}</p>
  }
  if (brief.background || result === undefined) {
    return <BackgroundReport taskId={taskId} toolUseId={brief.tool_use_id} />
  }
  return <ToolOutput taskId={taskId} result={result} />
}

function CardPrLink({ url, className }: { url: string; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      data-testid="subtask-pr"
      title={`Linked to this subagent: ${url}`}
      className={cn('flex min-w-0 items-center gap-0.5 text-primary hover:underline', className)}
    >
      <GitPullRequest className="size-3 shrink-0" />
      <span className="truncate">{prShortLabel(url, null)}</span>
    </a>
  )
}

/** One linked PR inline; several fold behind a count so the card never outgrows the transcript. */
function CardPrs({ urls }: { urls: readonly string[] }) {
  const [only] = urls
  if (urls.length === 0 || only === undefined) {
    return null
  }
  if (urls.length === 1) {
    return <CardPrLink url={only} className="max-w-40 shrink" />
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          data-testid="subtask-prs-count"
          className="shrink-0 text-primary pointer-coarse:min-h-11"
        >
          <GitPullRequest />
          {urls.length} PRs
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-72 w-64 overflow-y-auto p-1">
        <ul aria-label="Pull requests of this subagent">
          {urls.map((url) => (
            <li key={url}>
              <CardPrLink url={url} className="px-2 py-1 text-xs hover:bg-accent pointer-coarse:min-h-11" />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

interface SubtaskCardProps {
  taskId: string
  rowId: number
  startedAt: string
  block: ToolUseBlock
  result: ToolResultRef | undefined
  subtask: SubtaskBrief | undefined
  inputTrimmed: boolean
}

/** One subagent in its parent's transcript: where it stands, and a way into its own transcript. */
export function SubtaskCard({ taskId, rowId, startedAt, block, result, subtask, inputTrimmed }: SubtaskCardProps) {
  const brief = subtask ?? provisional(block, result, rowId, startedAt)
  const now = useNow(brief.status === 'running')
  const elapsed = subtaskElapsed(brief, now)
  const line = progressLine(brief)
  const promptSource = inputTrimmed ? { taskId, rowId, toolUseId: block.id, pick: fullInputText } : null
  const kind = [brief.subagent_type, brief.background ? 'background' : null].filter((part) => part !== null)
  return (
    <div
      data-testid="subtask-card"
      data-result-row={result?.rowId}
      className={cn(
        'min-w-0 border-l-2 bg-muted/40 text-xs',
        brief.status === 'failed' ? 'border-destructive' : 'border-primary/60',
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Bot className="size-3.5 shrink-0 text-primary" />
        <SubtaskPill status={brief.status} />
        <span className="min-w-0 flex-1 truncate font-semibold">{brief.description}</span>
        <CardPrs urls={brief.pr_urls} />
        {kind.length > 0 && <span className="min-w-0 truncate text-muted-foreground">{kind.join(' | ')}</span>}
        {elapsed !== null && <span className="shrink-0 text-muted-foreground tabular-nums">{elapsed}</span>}
        <Button
          variant="outline"
          size="xs"
          aria-label={`Open subagent ${brief.description}`}
          onClick={() => {
            navigate('agents', subtaskRouteId(taskId, block.id))
          }}
        >
          <ArrowUpRight />
          Open
        </Button>
      </div>
      {line !== null && (
        <div className="truncate px-2 pb-1.5 pl-7 text-muted-foreground" data-testid="subtask-progress">
          {line}
        </div>
      )}
      <details className="group border-t border-border">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 text-muted-foreground">
          <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
          Agent call and report
        </summary>
        <div className="space-y-2 border-t border-border px-2 py-2">
          <TrimmedText
            text={inputString(block.input, 'prompt') ?? JSON.stringify(block.input, null, 2)}
            source={promptSource}
            label="Full prompt"
            className="max-h-64"
          />
          <div className="space-y-2 border-t border-border pt-2">
            <CardReport taskId={taskId} brief={brief} result={result} />
          </div>
        </div>
      </details>
    </div>
  )
}
