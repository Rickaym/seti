import {
  listedStatus,
  runningSubtasks,
  type RewindResult,
  type SubtaskBrief,
  type Task,
  type TaskListEntry,
} from '@seti/shared'
import { Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { ChatFindBar } from '@/components/ChatFindBar'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useCommands } from '@/components/palette/useCommands'
import { useConfirm } from '@/components/ui/confirm-context'
import { useChatFindIn } from '@/hooks/useChatFind'
import { useDraft } from '@/hooks/useDraft'
import { useEscapeKeys } from '@/hooks/useEscapeKeys'
import { useNarrow } from '@/hooks/useMedia'
import { useRenderTurn } from '@/hooks/useRenderTurn'
import { useTailWindow } from '@/hooks/useTailWindow'
import { useTaskRewinds } from '@/hooks/useTaskRewinds'
import { useTaskStream, type TaskStream } from '@/hooks/useTaskStream'
import { refreshTaskLists } from '@/hooks/useTasks'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { compactingSince } from '@/lib/compacting'
import { taskDraftKey } from '@/lib/drafts'
import { PANEL, usePanelActions } from '@/lib/panels'
import { cn } from '@/lib/utils'
import { FilesSplit } from '@/panels/files/FilesSplit'
import { useFilesPane } from '@/panels/files/useFilesPane'
import { ProcessesSheet } from '@/panels/processes/ProcessesPanel'
import { useAgentProcesses } from '@/panels/processes/useAgentProcesses'
import { useQuestionsPane } from '@/panels/questions/useQuestionsPane'
import { AgentChat } from '@/panels/tasks/AgentChat'
import { AgentDockArea } from '@/panels/tasks/AgentDock'
import { AgentHeader } from '@/panels/tasks/AgentHeader'
import { BypassBadge } from '@/panels/tasks/BypassToggle'
import { RewindDialog } from '@/panels/tasks/RewindDialog'
import { StatusLight, StatusPill } from '@/panels/tasks/StatusPill'
import { TaskSettings } from '@/panels/tasks/TaskSettings'
import { TodoStrip } from '@/panels/tasks/TodoStrip'
import { HeaderUnseenDot } from '@/panels/tasks/UnseenDot'
import type { ActionHandlers } from '@/panels/tasks/agent-actions'
import { useAgentFrame, type AgentFrame } from '@/panels/tasks/agent-frame'
import { useCompactingResync } from '@/panels/tasks/useCompactingResync'
import { useMarkSeen } from '@/panels/tasks/useMarkSeen'
import { usePin } from '@/panels/tasks/usePin'
import { useAgentHasTerminal } from '@/panels/terminal/terminal-sources'

/** Rows a framed agent view renders at first; scrolling up reveals the rest of what is loaded. */
const PANEL_ROWS = 60

/** A framed view's newest rows, rendered in turn so frames do not all render at once. */
function usePanelRows(stream: TaskStream, frame: AgentFrame | null) {
  const rows = useTailWindow(stream, frame === null ? null : PANEL_ROWS)
  const turn = useRenderTurn(frame !== null && stream.ready, frame?.focused === true)
  return { rows, pending: !stream.ready || (frame !== null && !turn) }
}

interface TaskDetailProps {
  task: TaskListEntry
  onChanged: () => void
  /** Receives the task's subtasks each time its stream reports them. */
  onSubtasks: (taskId: string, subtasks: readonly SubtaskBrief[]) => void
}

/** Offers stopping the agent or its shell command in the palette while either runs. */
function useStopCommand(
  task: Task,
  { busy, shell }: { busy: boolean; shell: boolean },
  stop: () => Promise<void>,
): void {
  const confirm = useConfirm()
  const what = shell ? 'shell command' : 'agent'
  useCommands([
    {
      id: 'agent.stop',
      title: `Stop ${what}`,
      detail: task.title,
      icon: Square,
      group: 'Current agent',
      keywords: 'interrupt cancel halt',
      shortcut: 'Esc',
      when: (context) => busy && context.agent?.id === task.id,
      run: () => {
        const message = `Stop the ${what} of "${task.title}"?`
        void confirm({ message, confirmLabel: 'Stop', variant: 'destructive' }).then(async (ok) =>
          ok ? stop() : undefined,
        )
      },
    },
  ])
}

export function TaskDetail({ task, onChanged, onSubtasks }: TaskDetailProps) {
  const confirm = useConfirm()
  const stream = useTaskStream(task.id)
  const liveStatus = stream.status
  const status = liveStatus ?? task.status
  const busy = status === 'running' || stream.shell !== null
  const root = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useDraft(taskDraftKey(task.id))
  const [rewinding, setRewinding] = useState(false)
  const filesPane = useFilesPane(task.id)
  const questionsPane = useQuestionsPane(task.id, filesPane)
  const hasTerminal = useAgentHasTerminal(task.id)
  const narrow = useNarrow()
  const frame = useAgentFrame()
  const { rows, pending } = usePanelRows(stream, frame)
  const processes = useAgentProcesses(task.id, stream.session.open || hasTerminal, frame?.focused !== false)
  const pin = usePin(task, onChanged)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const { rewinds, reload: reloadRewinds } = useTaskRewinds(task.id, status)
  const compacting = useMemo(
    () => compactingSince(stream.messages, stream.fresh && status === 'running'),
    [stream.messages, stream.fresh, status],
  )
  useCompactingResync(compacting, stream.messages.at(-1)?.id, stream.resync)
  const { find, closeFind, marks } = useChatFindIn({
    path: `/tasks/${task.id}/search`,
    target: 'agent',
    toolRows: true,
    root,
    jumpTo: rows.jumpTo,
    backToLatest: stream.backToLatest,
    command: {
      id: 'agent.find',
      title: 'Search in this chat',
      detail: task.title,
      group: 'Current agent',
      when: (context) => context.agent?.id === task.id,
    },
  })

  useMarkSeen(task, status, liveStatus)
  useEffect(() => {
    if (liveStatus !== null) {
      onChanged()
    }
  }, [liveStatus, onChanged])

  const prLinks = stream.prLinks
  useEffect(() => {
    if (prLinks > 0) {
      onChanged()
    }
  }, [prLinks, onChanged])

  const subtasks = stream.subtasks
  const runningSubagents = subtasks.length > 0 ? runningSubtasks(subtasks) : task.subtask_counts.running
  useEffect(() => {
    if (subtasks.length > 0) {
      onSubtasks(task.id, subtasks)
    }
  }, [task.id, subtasks, onSubtasks])

  const archivedNow = stream.archived
  useEffect(() => {
    if (archivedNow !== null) {
      refreshTaskLists()
    }
  }, [archivedNow])

  const shellRunning = stream.shell !== null
  const stop = useCallback(async () => {
    const path = shellRunning ? `/tasks/${task.id}/shell/stop` : `/tasks/${task.id}/stop?queued=deliver`
    await apiPost(path).catch((e: unknown) => toast.error(errorText(e)))
  }, [task.id, shellRunning])

  useEscapeKeys({
    root,
    busy,
    onStop: stop,
    onRewind: useCallback(() => {
      setRewinding(true)
    }, []),
  })

  useStopCommand(task, { busy, shell: shellRunning }, stop)
  usePanelActions(root, {
    toggleFiles: () => {
      filesPane.setOpen(filesPane.request === null)
    },
  })

  const background = stream.session.background
  const endSession = async () => {
    const work = background === 1 ? 'the background subagent or command' : `${String(background)} background jobs`
    if (!(await confirm({ message: `Stop ${work} of "${task.title}"?`, variant: 'destructive' }))) {
      return
    }
    await apiPost(`/tasks/${task.id}/session/end`).catch((e: unknown) => toast.error(errorText(e)))
  }

  const rewound = (result: RewindResult) => {
    setRewinding(false)
    reloadRewinds()
    onChanged()
    if (result.rewind.restore !== 'code') {
      setDraft(result.prompt)
    }
    const files = result.rewind.files_changed.length
    const restored = `Restored ${String(files)} ${files === 1 ? 'file' : 'files'}`
    toast.success(
      result.rewind.restore === 'code' ? restored : 'Rewound. Edit the prompt and send it to continue from there.',
    )
  }

  const shownStatus = listedStatus({ ...task, status }, runningSubagents)
  const pill = (
    <>
      <HeaderUnseenDot unseen={task.unseen} status={status} />
      <StatusPill status={shownStatus} subagents={runningSubagents} />
      <BypassBadge until={task.bypass_until} />
    </>
  )
  const settings = (compact = false) => (
    <ErrorBoundary name="Agent settings" kind="item">
      <TaskSettings
        task={task}
        onChanged={onChanged}
        busy={busy || background > 0}
        running={status === 'running'}
        compact={compact}
      />
    </ErrorBoundary>
  )
  const running = { busy, background, processes: processes.running }
  const handlers: ActionHandlers = {
    find: find.openFind,
    files: () => {
      filesPane.setOpen(true)
    },
    processes: () => {
      processes.setOpen(true)
    },
    questions: questionsPane.toggle,
    pin: (pinned) => void pin(pinned),
    rename: () => {
      setTitleDraft(task.title)
    },
    stop: () => void stop(),
    endBackground: () => void endSession(),
  }
  return (
    <FilesSplit taskId={task.id} pane={filesPane} questions={questionsPane} readOnly={false}>
      <div
        ref={root}
        {...agentColorAttr(task.color)}
        {...(frame === null ? PANEL : {})}
        className={cn('flex h-full min-h-0 min-w-0 flex-1 flex-col', frame === null && '@container/agent')}
      >
        <div className="agent-tint shrink-0">
          <AgentHeader
            task={task}
            onChanged={onChanged}
            frame={frame}
            narrow={narrow}
            pill={pill}
            light={<StatusLight status={shownStatus} place="header" subagents={runningSubagents} agent={task} />}
            subtasks={subtasks}
            titleDraft={titleDraft}
            onTitleDraft={setTitleDraft}
            settings={settings}
            running={running}
            shell={shellRunning}
            on={handlers}
            processes={processes}
            filesPane={filesPane}
          />
        </div>
        <TodoStrip taskId={task.id} todos={stream.todos ?? task.todos} agent={shownStatus} />
        <ProcessesSheet taskId={task.id} processes={processes} />
        <ChatFindBar find={find} onClose={closeFind} />
        <AgentDockArea task={task} sheet={narrow && frame === null}>
          <AgentChat
            task={task}
            status={status}
            transcript={{
              stream: rows,
              rewinds,
              subtasks,
              load: { pending, failed: stream.failed, onRetry: stream.retry },
              find: marks,
            }}
            messages={stream.messages}
            shell={stream.shell}
            permissions={stream.permissions}
            compacting={compacting}
            draft={draft}
            onDraftChange={setDraft}
            onChanged={onChanged}
          />
        </AgentDockArea>
        {rewinding && (
          <RewindDialog
            taskId={task.id}
            onClose={() => {
              setRewinding(false)
            }}
            onRewound={rewound}
          />
        )}
      </div>
    </FilesSplit>
  )
}
