import type { MessageRow, ShellProgress, Task } from '@seti/shared'
import { useEffect, useMemo, type ComponentProps } from 'react'
import { usePendingSends } from '@/hooks/usePendingSends'
import { useTranscriptBlocks } from '@/hooks/useTranscriptBlocks'
import { confirmedIds } from '@/lib/pending-sends'
import { ChangeRequests } from '@/panels/tasks/ChangeRequests'
import { CompactingNote } from '@/panels/tasks/CompactingNote'
import { Composer } from '@/panels/tasks/Composer'
import { TaskFailure } from '@/panels/tasks/FailureNotice'
import { PendingSends } from '@/panels/tasks/PendingSends'
import { PermissionRequests } from '@/panels/tasks/PermissionRequests'
import { ShellLive } from '@/panels/tasks/ShellEntry'
import { QueuedInputs } from '@/panels/tasks/TaskInputs'
import { TranscriptPane } from '@/panels/tasks/TranscriptPane'

type TranscriptProps = ComponentProps<typeof TranscriptPane>

const NONE: ReadonlySet<string> = new Set()

/** The task's unsent messages that the transcript rows do not hold yet; the rest are dropped. */
function usePendingRows(taskId: string, rows: TranscriptProps['stream']['messages']) {
  const { store, sends, added } = usePendingSends(taskId)
  const waiting = sends.length > 0
  const confirmed = useMemo(() => (waiting ? confirmedIds(rows) : NONE), [waiting, rows])
  const shown = useMemo(() => sends.filter((send) => !confirmed.has(send.clientId)), [sends, confirmed])
  useEffect(() => {
    store.confirm(confirmed)
  }, [store, confirmed])
  return { store, unsent: { rows: <PendingSends sends={shown} store={store} />, count: shown.length, added } }
}

interface AgentChatProps {
  task: Task
  status: Task['status']
  /** What the transcript shows: its rows, rewinds, subagents, loading state and find marks. */
  transcript: Pick<TranscriptProps, 'stream' | 'rewinds' | 'subtasks' | 'load' | 'find'>
  messages: readonly MessageRow[]
  shell: ShellProgress | null
  /** Changes each time the agent's permission requests may have changed. */
  permissions: number
  /** When the conversation started compacting, while it does. */
  compacting: string | null
  draft: string
  onDraftChange: (draft: string) => void
  onChanged: () => void
}

/** The agent's transcript, the updates it has not read and the composer below. */
export function AgentChat({
  task,
  status,
  transcript,
  messages,
  shell,
  permissions,
  compacting,
  draft,
  onDraftChange,
  onChanged,
}: AgentChatProps) {
  const running = status === 'running'
  const { store, unsent } = usePendingRows(task.id, transcript.stream.messages)
  const blocks = useTranscriptBlocks(task.id)
  return (
    <>
      <TranscriptPane
        taskId={task.id}
        {...transcript}
        unsent={unsent}
        blocks={blocks}
        running={running}
        empty="No messages yet. A reply below starts this agent's first turn."
      >
        <PermissionRequests taskId={task.id} blocked={task.blocked} version={permissions} />
        <ChangeRequests taskId={task.id} blocked={task.blocked} version={permissions} />
        {(status === 'error' || status === 'interrupted') && (
          <TaskFailure task={task} status={status} onChanged={onChanged} />
        )}
        {compacting !== null && <CompactingNote since={compacting} />}
        {shell !== null && (
          <div className="mt-3">
            <ShellLive progress={shell} />
          </div>
        )}
      </TranscriptPane>
      <QueuedInputs task={task} messages={messages} running={running} />
      <Composer
        taskId={task.id}
        cwd={task.cwd}
        agentRunning={running}
        compacting={compacting !== null}
        shellRunning={shell !== null}
        draft={draft}
        onDraftChange={onDraftChange}
        sends={store}
      />
    </>
  )
}
