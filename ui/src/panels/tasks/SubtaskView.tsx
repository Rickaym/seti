import {
  listedStatus,
  runningSubtasks,
  type Subtask,
  type SubtaskBrief,
  type Task,
  type TaskDisplayStatus,
  type TaskListEntry,
  type TaskRewind,
} from '@seti/shared'
import { ArrowLeft, Bot, ChevronRight, Square } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { BackButton, DetailTitle } from '@/components/SplitPane'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/useNow'
import { useSubtaskStream } from '@/hooks/useSubtaskStream'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { navigate } from '@/lib/route'
import { subtaskElapsed, subtaskRouteId } from '@/lib/subtasks'
import { StatusPill, SubtaskPill } from '@/panels/tasks/StatusPill'
import { SubagentStrip } from '@/panels/tasks/SubagentStrip'
import { SubtaskPrs } from '@/panels/tasks/TaskPrs'
import { TranscriptPane } from '@/panels/tasks/TranscriptPane'
import { DetailSkeleton } from '@/panels/tasks/TranscriptSkeleton'

const Markdown = lazy(async () => import('@/components/Markdown').then((m) => ({ default: m.Markdown })))

const NO_REWINDS: readonly TaskRewind[] = []

/** The subtask with its prompt and report, fetched again whenever its brief changes. */
function useSubtaskDetail(taskId: string, brief: SubtaskBrief | undefined, toolUseId: string) {
  const [detail, setDetail] = useState<Subtask | null>(null)
  const [missing, setMissing] = useState(false)
  const version = brief === undefined ? '' : [brief.status, brief.ended_at, brief.tool_use_ids.length].join(':')
  useEffect(() => {
    let current = true
    apiGet<Subtask>(`/tasks/${taskId}/subtasks/${toolUseId}`)
      .then((found) => {
        if (current) {
          setDetail(found)
        }
      })
      .catch(() => {
        if (current) {
          setMissing(true)
        }
      })
    return () => {
      current = false
    }
  }, [taskId, toolUseId, version])
  return { detail, missing }
}

function Report({ text }: { text: string }) {
  return (
    <Suspense fallback={<pre className="text-sm whitespace-pre-wrap">{text}</pre>}>
      <Markdown text={text} />
    </Suspense>
  )
}

function ParentLink({ task, parent }: { task: Task; parent: SubtaskBrief | undefined }) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <Button
        variant="ghost"
        size="xs"
        className="min-w-0 shrink"
        onClick={() => {
          navigate('agents', task.id)
        }}
      >
        <ArrowLeft /> <span className="truncate">{task.title}</span>
      </Button>
      {parent !== undefined && (
        <>
          <ChevronRight className="size-3 shrink-0" />
          <Button
            variant="ghost"
            size="xs"
            className="min-w-0 shrink"
            onClick={() => {
              navigate('agents', subtaskRouteId(task.id, parent.tool_use_id))
            }}
          >
            <span className="truncate">{parent.description}</span>
          </Button>
        </>
      )}
    </div>
  )
}

function SubtaskFacts({ subtask, taskStatus }: { subtask: SubtaskBrief; taskStatus: TaskDisplayStatus }) {
  const now = useNow(subtask.status === 'running')
  const elapsed = subtaskElapsed(subtask, now)
  const { usage } = subtask
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{subtask.subagent_type ?? 'subagent'}</span>
      <span>{subtask.background ? 'background' : 'foreground'}</span>
      {elapsed !== null && <span className="tabular-nums">{elapsed}</span>}
      {usage !== null && (
        <span>
          {usage.tool_uses} tool uses | {(usage.total_tokens / 1000).toFixed(1)}k tokens
        </span>
      )}
      <span className="flex items-center gap-1">
        agent <StatusPill status={taskStatus} />
      </span>
    </div>
  )
}

function PromptDetails({ prompt }: { prompt: string }) {
  return (
    <details className="group text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" /> Prompt
      </summary>
      <pre className="mt-1 max-h-48 overflow-auto border-l-2 border-border bg-muted/40 px-2 py-1.5 whitespace-pre-wrap">
        {prompt}
      </pre>
    </details>
  )
}

/** Stops the subagent through the SDK while the session that runs it is open. */
function StopButton({ taskId, toolUseId }: { taskId: string; toolUseId: string }) {
  const stop = async () => {
    await apiPost(`/tasks/${taskId}/subtasks/${toolUseId}/stop`).catch((e: unknown) => toast.error(errorText(e)))
  }
  return (
    <Hint text="Stop this subagent; the parent agent keeps running">
      <Button variant="outline" size="sm" aria-label="Stop subagent" onClick={() => void stop()}>
        <Square />
        Stop
      </Button>
    </Hint>
  )
}

interface HeaderProps {
  task: TaskListEntry
  subtask: SubtaskBrief
  parent: SubtaskBrief | undefined
  taskStatus: TaskDisplayStatus
  prompt: string | null
}

function SubtaskHeader({ task, subtask, parent, taskStatus, prompt }: HeaderProps) {
  const canStop = subtask.status === 'running' && subtask.sdk_task_id !== null
  return (
    <div
      className="agent-tint agent-rule shrink-0 space-y-1 border-b border-border px-5 py-3 max-md:px-3 max-md:py-2"
      data-panel-handle=""
    >
      <ParentLink task={task} parent={parent} />
      <div className="flex items-start justify-between gap-4 max-[48rem]:flex-wrap max-[48rem]:gap-2">
        <div className="min-w-0 space-y-1 max-[48rem]:basis-full">
          <div className="flex items-center gap-2">
            <BackButton section="agents" label="agents" />
            <Bot className="size-4 shrink-0 text-primary" />
            <DetailTitle>{subtask.description}</DetailTitle>
            <SubtaskPill status={subtask.status} />
          </div>
          <SubtaskFacts subtask={subtask} taskStatus={taskStatus} />
          <SubtaskPrs task={task} subtask={subtask} />
        </div>
        {canStop && <StopButton taskId={task.id} toolUseId={subtask.tool_use_id} />}
      </div>
      {prompt !== null && prompt !== '' && <PromptDetails prompt={prompt} />}
    </div>
  )
}

function emptyNote(subtask: SubtaskBrief): string {
  return subtask.status === 'unknown'
    ? 'This transcript holds no messages of this subagent.'
    : 'No messages from this subagent yet.'
}

interface SubtaskViewProps {
  task: TaskListEntry
  toolUseId: string
  onSubtasks: (taskId: string, subtasks: readonly SubtaskBrief[]) => void
}

/** A subagent's own transcript, read-only: its parent agent directs it. */
export function SubtaskView({ task, toolUseId, onSubtasks }: SubtaskViewProps) {
  const stream = useSubtaskStream(task.id, toolUseId)
  const { subtasks } = stream
  const brief = subtasks.find((subtask) => subtask.tool_use_id === toolUseId)
  const { detail, missing } = useSubtaskDetail(task.id, brief, toolUseId)
  const listed = task.running_subtasks.find((subtask) => subtask.tool_use_id === toolUseId)
  const current = brief ?? detail ?? listed
  const parent = subtasks.find((subtask) => subtask.tool_use_id === current?.parent_tool_use_id)

  useEffect(() => {
    if (subtasks.length > 0) {
      onSubtasks(task.id, subtasks)
    }
  }, [task.id, subtasks, onSubtasks])

  if (current === undefined) {
    return missing ? (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        This subagent is not in the agent.
      </div>
    ) : (
      <DetailSkeleton />
    )
  }

  const report = detail?.result ?? null
  const running = subtasks.length > 0 ? runningSubtasks(subtasks) : task.subtask_counts.running
  return (
    <div {...agentColorAttr(task.color)} className="flex h-full min-h-0 flex-col">
      <SubtaskHeader
        task={task}
        subtask={current}
        parent={parent}
        taskStatus={listedStatus({ ...task, status: stream.status ?? task.status }, running)}
        prompt={detail?.prompt ?? null}
      />
      <SubagentStrip taskId={task.id} subtasks={subtasks} selected={toolUseId} />
      <TranscriptPane
        taskId={task.id}
        stream={stream}
        rewinds={NO_REWINDS}
        running={current.status === 'running'}
        subtasks={subtasks}
        subagentRows
        load={{ pending: !stream.ready, failed: stream.failed, onRetry: stream.retry }}
      >
        {stream.ready && stream.messages.length === 0 && !stream.hasOlder && (
          <p className="text-xs text-muted-foreground">{emptyNote(current)}</p>
        )}
        {report !== null && (
          <div
            className="mt-3 space-y-1 border-l-2 border-primary/60 bg-muted/40 px-3 py-2"
            data-testid="subtask-report"
          >
            <div className="text-xs font-semibold text-muted-foreground">Report</div>
            <Report text={report} />
          </div>
        )}
      </TranscriptPane>
      <div className="shrink-0 border-t border-border px-5 py-2 text-xs text-muted-foreground max-md:px-3">
        Read-only. The parent agent directs this subagent; message the parent agent to change its work.
      </div>
    </div>
  )
}
